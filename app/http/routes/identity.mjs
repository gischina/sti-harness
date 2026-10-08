/**
 * 身份与权限路由（M1）。
 *
 * 分层纪律：本文件**只做**「解析请求 → 调 service → 组织响应」。
 * 校验、加密、事务、权限判定都在各自的下层（service / permissions / 仓储）。
 * 所以这里看不到一句 SQL、也看不到一次哈希计算。
 *
 * 鉴权不在 handler 里写：`scope` 已经在路由表上声明，`auth`/`tenant`/`rbac`
 * 三个中间件会按声明执行。handler 能拿到的 `ctx.user` 一定是已认证的身份。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { readJsonBody } from '../context.mjs';
import { matrixFor, describePermissions, ROLE_KEYS, ROLE_MATRIX } from '../../platform/identity/permissions.mjs';
import { sessionCookie, clearSessionCookie, clearAllSessionCookies, extractToken } from '../../platform/identity/tokens.mjs';
import * as audit from '../../platform/governance/audit.mjs';
import { requireBody } from './_shared.mjs';
// 初始化向导走完时顺手建默认工作区（0.21.1）—— 路径同样只从 paths.mjs 推导，
// 这里不拼第二份"默认目录在哪"。
import { WORKSPACE_DIR } from '../../paths.mjs';

/** 请求是否走 HTTPS（决定 cookie 要不要加 Secure）。支持反代场景的 x-forwarded-proto。 */
function isSecureReq(ctx) {
  const h = ctx.req.headers || {};
  if (String(h['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  const sock = ctx.req.socket || {};
  return !!(sock.encrypted || (sock.socket && sock.socket.encrypted));
}

function clientInfo(ctx) {
  const h = ctx.req.headers || {};
  const ip = (ctx.req.socket && ctx.req.socket.remoteAddress) || '';
  const fwd = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return { ip: fwd || ip, ua: String(h['user-agent'] || '') };
}

export function identityRoutes(deps) {
  const { identity, workspace } = deps;

  const routes = [
    // ── 初始化向导 ────────────────────────────────────────────────────
    {
      id: 'identity.setup.status',
      method: 'GET',
      path: '/api/identity/setup',
      scope: 'public',
      summary: '初始化状态（是否已有组织与管理员）',
      /**
       * ⚠️ 这是**未认证**就能调的接口，因此只回"要不要初始化"与组织名 ——
       * 组织名是登录页必须显示的必要上下文（多组织部署下用户要知道自己连的是哪台）。
       *
       * 刻意**不回** `userCount` / `orgCount`：账号数是"这家公司有多大"的规模情报，
       * 把它送给任何一个能碰到端口的人没有收益，只有风险。
       * （内部仍在 `identity.setupStatus()` 里算 —— 那是给 `requireSetup()` 用的，
       * 与这个对外投影是两件事。）
       */
      handler: (ctx) => {
        const st = identity.setupStatus();
        ctx.ok({
          setup: {
            initialized: !!st.initialized,
            needsSetup: !!st.needsSetup,
            org: st.org ? { id: st.org.id, name: st.org.name, slug: st.org.slug } : null,
          },
        });
      },
    },
    {
      id: 'identity.setup.run',
      method: 'POST',
      path: '/api/identity/setup',
      scope: 'public',
      summary: '初始化向导：建组织 + 管理员 + 可选模型凭据',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        requireBody({
          orgName: { required: true, maxLen: 128, label: '组织名' },
          adminUsername: { required: true, maxLen: 64, label: '管理员用户名' },
          adminPassword: { required: true, maxLen: 1024, label: '管理员口令' },
          adminDisplayName: { maxLen: 128, label: '管理员显示名' },
        }, body);
        const result = await identity.runSetup({
          orgName: body.orgName,
          adminUsername: body.adminUsername,
          adminPassword: body.adminPassword,
          adminDisplayName: body.adminDisplayName,
          credential: body.credential || null,
        });
        audit.append({
          tenantId: 'system',
          userId: null,
          action: 'identity.setup',
          resourceType: 'org',
          resourceId: result.org.id,
          result: 'ok',
          detail: { orgName: result.org.name, admin: result.admin.username, rolesCreated: result.rolesCreated },
        });
        // 初始化时给一个"能立刻用起来"的默认工作区（0.21.1）：否则用户走进工作台
        // 看到的是一棵空树，第一反应是"这东西坏了"。owner 记成刚建的管理员。
        // ⚠️ 0.21.9：**不再连带播一条落脚会话**（用户裁定：初始化后只有默认工作区，
        // 不再有默认会话）。树里那条默认工作区本身就能消除"空树"的观感 ——
        // 要开始对话，点它行尾的「＋」即可。理由见 workspace/service.mjs 顶部。
        // 路径由运行时推导（paths.mjs 的 WORKSPACE_DIR），不写死在源码里。
        // 失败只如实带一句 note，不让"补默认工作区"把一个已经成功的初始化搞成失败。
        let defaultWorkspace = null;
        let workspaceNote = '';
        if (workspace && typeof workspace.ensureDefaultWorkspace === 'function') {
          try {
            defaultWorkspace = workspace.ensureDefaultWorkspace({
              tenantId: result.org.id, ownerUserId: result.admin.id, cwd: WORKSPACE_DIR,
            });
          } catch (e) {
            workspaceNote = '默认工作区未建立（' + (e && e.message) + '）—— 可到工作台左栏点「＋工作区」自行创建。';
          }
        }
        ctx.json(201, {
          ok: true, ...result,
          defaultWorkspace: defaultWorkspace
            ? { id: defaultWorkspace.id, name: defaultWorkspace.name, cwd: defaultWorkspace.cwd }
            : null,
          workspaceNote,
        });
      },
    },

    // ── 登录 / 登出 / 我是谁 ──────────────────────────────────────────
    {
      id: 'identity.login',
      method: 'POST',
      path: '/api/identity/login',
      scope: 'public',
      summary: '登录（scrypt 校验 + 下发 HMAC 会话令牌）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        requireBody({
          username: { required: true, maxLen: 128, label: '用户名' },
          password: { required: true, maxLen: 1024, label: '口令' },
          orgSlug: { maxLen: 64, label: '组织标识' },
        }, body);
        const { ip, ua } = clientInfo(ctx);
        const r = await identity.login({
          username: body.username,
          password: body.password,
          orgSlug: body.orgSlug || null,
          ip, ua,
        });

        // 两步验证：口令正确但登录**未完成** —— 只回一次性票据，不发 cookie、不记"登录成功"。
        // 至此只证明"知道口令"；identity.login 的审计记在第二步完成后（见 login.totp 路由）。
        if (r.twoFactorRequired) {
          return ctx.ok({
            ok: true,
            twoFactorRequired: true,
            ticket: r.ticket,
            expiresAt: r.expiresAt,
            note: '该账号启用了两步验证：请在 5 分钟内提交验证器上的 6 位动态码（或一张一次性恢复码）。',
          });
        }

        const secure = isSecureReq(ctx);
        const cookies = [sessionCookie(r.token, {
          maxAgeSec: Math.max(0, Math.floor((Date.parse(r.expiresAt) - Date.now()) / 1000)),
          secure,
        })];
        // HTTPS 换用 __Host- 前缀时，顺手清掉浏览器里可能残留的历史明名 cookie（过渡期收尾）
        if (secure) cookies.push(clearSessionCookie({ secure: false }));
        ctx.setHeader('set-cookie', cookies);
        audit.append({
          tenantId: r.user.orgId,
          userId: r.user.id,
          action: 'identity.login',
          resourceType: 'user',
          resourceId: r.user.id,
          result: 'ok',
          detail: { username: r.user.username, ip },
        });
        ctx.ok({
          user: r.user,
          expiresAt: r.expiresAt,
          // 令牌只在 body 里给一次，供非浏览器客户端用（浏览器那边已通过 httpOnly cookie 拿到）
          token: r.token,
          tokenHint: '浏览器请使用 httpOnly cookie；脚本/集成请用 Authorization: Bearer <token>',
        });
      },
    },
    {
      id: 'identity.login.totp',
      method: 'POST',
      path: '/api/identity/login/totp',
      scope: 'public',
      summary: '两步登录第二步：票据 + 动态码/恢复码 → 会话',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        requireBody({
          ticket: { required: true, maxLen: 256, label: '登录票据' },
          code: { required: true, maxLen: 32, label: '验证码' },
        }, body);
        const { ip, ua } = clientInfo(ctx);
        const r = await identity.loginTotp({ ticket: body.ticket, code: body.code, ip, ua });
        const secure = isSecureReq(ctx);
        const cookies = [sessionCookie(r.token, {
          maxAgeSec: Math.max(0, Math.floor((Date.parse(r.expiresAt) - Date.now()) / 1000)),
          secure,
        })];
        if (secure) cookies.push(clearSessionCookie({ secure: false }));
        ctx.setHeader('set-cookie', cookies);
        audit.append({
          tenantId: r.user.orgId,
          userId: r.user.id,
          action: 'identity.login',
          resourceType: 'user',
          resourceId: r.user.id,
          result: 'ok',
          detail: { username: r.user.username, ip, twoFactor: true, viaRecoveryCode: !!r.viaRecoveryCode },
        });
        ctx.ok({
          user: r.user,
          expiresAt: r.expiresAt,
          token: r.token,
          tokenHint: '浏览器请使用 httpOnly cookie；脚本/集成请用 Authorization: Bearer <token>',
          ...(r.viaRecoveryCode ? { viaRecoveryCode: true, recoveryCodesLeft: r.recoveryCodesLeft } : {}),
        });
      },
    },
    {
      id: 'identity.logout',
      method: 'POST',
      path: '/api/identity/logout',
      scope: 'session',
      summary: '登出（吊销当前会话令牌）',
      handler: (ctx) => {
        const { token } = extractToken(ctx.req);
        const r = identity.logout(token);
        ctx.setHeader('set-cookie', clearAllSessionCookies({ secure: isSecureReq(ctx) }));
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.logout', resourceType: 'session',
          resourceId: ctx.auth && ctx.auth.sessionId ? ctx.auth.sessionId : '',
          result: 'ok', detail: { revoked: r.revoked },
        });
        ctx.ok({ revoked: r.revoked });
      },
    },
    {
      id: 'identity.me',
      method: 'GET',
      path: '/api/identity/me',
      scope: 'session',
      summary: '当前用户、角色与权限矩阵',
      handler: (ctx) => {
        const roles = ctx.user.roles || [];
        ctx.ok({
          user: ctx.user,
          roles,
          permissions: matrixFor(roles),
          permissionsMeta: describePermissions(),
          auth: {
            // 携带方式（authorization / x-sti-token / cookie）与凭证种类（session / api-key）分开报，
            // 前端与排障时这两个问题都要能回答清楚。
            via: ctx.auth.via,
            credential: ctx.auth.credential,
            sessionId: ctx.auth.sessionId,
            apiKeyId: ctx.auth.apiKeyId,
            scopes: ctx.auth.scopes || [],
          },
        });
      },
    },

    // ── 账号管理 ──────────────────────────────────────────────────────
    {
      id: 'identity.users',
      method: 'GET',
      path: '/api/identity/users',
      scope: 'admin',
      capability: ['user:read'],
      summary: '用户列表',
      handler: (ctx) => {
        const users = identity.listUsers(ctx.tenantId, {
          limit: Number(ctx.query.limit || 100),
          offset: Number(ctx.query.offset || 0),
        });
        ctx.ok({ users, total: users.length });
      },
    },
    {
      id: 'identity.users.create',
      method: 'POST',
      path: '/api/identity/users',
      scope: 'admin',
      capability: ['user:write'],
      summary: '新建用户（可同时指定角色）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        requireBody({
          username: { required: true, maxLen: 64, label: '用户名' },
          password: { required: true, maxLen: 1024, label: '口令' },
          displayName: { maxLen: 128, label: '显示名' },
          deptId: { maxLen: 64, label: '部门 ID' },
          roles: { type: 'stringArray', maxLen: 16, label: '角色' },
        }, body);
        const user = await identity.createUser({
          orgId: ctx.tenantId,
          username: body.username,
          password: body.password,
          displayName: body.displayName,
          deptId: body.deptId || null,
          roleKeys: Array.isArray(body.roles) && body.roles.length ? body.roles : ['member'],
        });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.user.create', resourceType: 'user', resourceId: user.id,
          result: 'ok', detail: { username: user.username, roles: user.roles },
        });
        ctx.json(201, { ok: true, user });
      },
    },
    {
      id: 'identity.users.import',
      method: 'POST',
      path: '/api/identity/users/import',
      scope: 'admin',
      capability: ['user:write'],
      summary: 'CSV 批量导入用户（逐行独立：一行失败只跳过该行，报表回行号与原因）',
      /**
       * 请求体上限显式放宽到 2MB：512KB 的 CSV 文本经 JSON 转义（换行、引号翻倍）
       * 后接近 2×，默认 256KB 会把合法文件在中间掐掉（413 报"太大"却查无实据）。
       * 路径 `.../import` 是静态段，路由匹配按通配符数排序，必然赢过 `:id` 系的路由。
       */
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req, 2 * 1024 * 1024);
        requireBody({ csv: { required: true, maxLen: 512 * 1024, label: 'CSV 文本' } }, body);
        const report = await identity.importUsers(ctx.tenantId, { csv: body.csv });
        // 每个**成功**的行单独留一条与单建账号同名的审计 —— 导入不是"黑箱批量"，
        // 谁被建出来必须逐条可查（明细带 via:'import' 与 CSV 行号，方便对账）。
        for (const row of report.rows) {
          if (!row.ok) continue;
          audit.append({
            tenantId: ctx.tenantId, userId: ctx.userId,
            action: 'identity.user.create', resourceType: 'user', resourceId: row.id,
            result: 'ok', detail: { username: row.username, via: 'import', line: row.line },
          });
        }
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.users.import', resourceType: 'user', resourceId: '',
          result: 'ok', detail: { total: report.total, created: report.created, failed: report.failed },
        });
        ctx.ok({ report });
      },
    },
    {
      id: 'identity.users.roles',
      method: 'PUT',
      path: '/api/identity/users/:id/roles',
      scope: 'admin',
      capability: ['role:write'],
      summary: '设置用户角色（整组替换）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const before = identity.listUsers(ctx.tenantId).find((u) => u.id === ctx.params.id);
        const user = identity.setUserRoles(ctx.tenantId, ctx.params.id, Array.isArray(body.roles) ? body.roles : []);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.user.set-roles', resourceType: 'user', resourceId: user.id,
          result: 'ok', detail: { before: before ? before.roles : null, after: user.roles },
        });
        ctx.ok({ user });
      },
    },
    {
      id: 'identity.users.status',
      method: 'PUT',
      path: '/api/identity/users/:id/status',
      scope: 'admin',
      capability: ['user:write'],
      summary: '启用 / 停用账号（停用会踢下线）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const user = identity.setUserStatus(ctx.tenantId, ctx.params.id, String(body.status || ''));
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.user.set-status', resourceType: 'user', resourceId: user.id,
          result: 'ok', detail: { status: user.status },
        });
        ctx.ok({ user });
      },
    },
    {
      id: 'identity.users.password',
      method: 'POST',
      path: '/api/identity/users/:id/password',
      scope: 'admin',
      capability: ['user:write'],
      summary: '重置口令（会吊销该用户全部会话）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const r = await identity.resetPassword(ctx.tenantId, ctx.params.id, body.password);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.user.reset-password', resourceType: 'user', resourceId: ctx.params.id,
          result: 'ok', detail: { sessionsRevoked: true },
        });
        ctx.ok(r);
      },
    },
    {
      id: 'identity.users.totp-reset',
      method: 'POST',
      path: '/api/identity/users/:id/totp-reset',
      scope: 'admin',
      // 与重置口令同档：属于 `user:write` 的常规安全运维（丢设备的用户要能尽快恢复）。
      // 语义注意：**不动口令、不吊销会话** —— 这是轻处置；更强处置是「重置口令」。
      capability: ['user:write'],
      summary: '重置某个用户的两步验证（清第二因子与未完成票据；不动口令）',
      handler: (ctx) => {
        const r = identity.resetUserTotp(ctx.tenantId, ctx.params.id);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.user.totp-reset', resourceType: 'user', resourceId: r.id,
          result: 'ok', detail: { username: r.username, hadTotp: r.hadTotp, codesRemoved: r.codesRemoved },
        });
        ctx.ok(r);
      },
    },

    {
      id: 'identity.users.delete',
      method: 'DELETE',
      path: '/api/identity/users/:id',
      scope: 'admin',
      // 删除不可逆，单独一个 `user:delete` —— 权限矩阵里默认档**不含** delete，
      // 所以它必须被显式授予（不能靠 `user:write` 顺带给出，见 permissions.mjs）。
      capability: ['user:delete'],
      summary: '删除账号（真删：连带清掉其会话 / API Key / 组关系 / 角色绑定；审计保留）',
      handler: (ctx) => {
        const r = identity.deleteUser(ctx.tenantId, ctx.params.id, { actorUserId: ctx.userId });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.user.delete', resourceType: 'user', resourceId: r.id,
          result: 'ok', detail: { username: r.username, removed: r.removed },
        });
        ctx.ok(r);
      },
    },

    {
      id: 'identity.users.profile',
      method: 'PUT',
      path: '/api/identity/users/:id',
      scope: 'admin',
      capability: ['user:write'],
      summary: '改用户资料（姓名 / 部门归属）—— 口令、状态、角色各有自己的路径',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        // ⚠️ 只把**出现过**的键传下去：`undefined` = 不改这项，`null` = 清空部门归属。
        //    写成 `body.deptId || null` 会把"没传"变成"清空" —— 一次改姓名就把人的
        //    部门归属抹掉，而且接口会回 200 说改成功了。
        const patch = {};
        if (body.displayName !== undefined) patch.displayName = body.displayName;
        if (body.deptId !== undefined) patch.deptId = body.deptId;
        const user = identity.setUserProfile(ctx.tenantId, ctx.params.id, patch);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.user.set-profile', resourceType: 'user', resourceId: user.id,
          result: 'ok', detail: { displayName: user.displayName, deptId: user.deptId },
        });
        ctx.ok({ user });
      },
    },

    // ── 部门 ──────────────────────────────────────────────────────────
    //
    // ⚠️ 部门**不是权限载体**（详见 identity/service.mjs 的部门小节）：
    //    它只表示"这个人在哪个单位"，挂在哪个部门不会改变任何权限判定。
    //    权限仍然只走角色绑定与用户组。这里刻意不叫 `/roles` 之类容易误解的名字。
    {
      id: 'identity.departments',
      method: 'GET',
      path: '/api/identity/departments',
      scope: 'admin',
      capability: ['department:read'],
      summary: '部门列表（含成员数）。部门是组织归属，不是权限载体',
      handler: (ctx) => {
        const departments = identity.listDepartments(ctx.tenantId);
        ctx.ok({
          departments,
          note: '部门只表示组织归属，不参与权限判定；权限来自角色绑定与用户组。'
            + '改名与删除在部门表格里操作；有成员或有子部门的部门会被**拒绝删除**并给出原因。',
        });
      },
    },
    {
      id: 'identity.departments.create',
      method: 'POST',
      path: '/api/identity/departments',
      scope: 'admin',
      capability: ['department:write'],
      summary: '新建部门',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const dept = identity.createDepartment(ctx.tenantId, {
          name: body.name,
          parentId: body.parentId || null,
        });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.department.create', resourceType: 'department', resourceId: dept.id,
          result: 'ok', detail: { name: dept.name, parentId: dept.parentId },
        });
        ctx.json(201, { ok: true, department: dept });
      },
    },
    {
      id: 'identity.departments.rename',
      method: 'PATCH',
      path: '/api/identity/departments/:id',
      scope: 'admin',
      capability: ['department:write'],
      summary: '部门改名',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        // before 从列表查一次（与 identity.users.roles 同一做法）——审计要记"从什么改成了什么"。
        const before = identity.listDepartments(ctx.tenantId).find((d) => d.id === ctx.params.id);
        const dept = identity.renameDepartment(ctx.tenantId, ctx.params.id, { name: body.name });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.department.rename', resourceType: 'department', resourceId: dept.id,
          result: 'ok', detail: { before: before ? before.name : null, after: dept.name },
        });
        ctx.ok({ department: dept });
      },
    },
    {
      id: 'identity.departments.delete',
      method: 'DELETE',
      path: '/api/identity/departments/:id',
      scope: 'admin',
      capability: ['department:delete'],
      summary: '删除部门（有成员或有子部门时拒绝，并说明原因）',
      handler: (ctx) => {
        const r = identity.deleteDepartment(ctx.tenantId, ctx.params.id);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.department.delete', resourceType: 'department', resourceId: r.id,
          result: 'ok', detail: { name: r.name },
        });
        ctx.ok({ ok: true, id: r.id });
      },
    },

    // ── 角色 ──────────────────────────────────────────────────────────
    {
      id: 'identity.roles',
      method: 'GET',
      path: '/api/identity/roles',
      scope: 'admin',
      capability: ['role:read'],
      summary: '角色列表与权限矩阵',
      handler: (ctx) => {
        const roles = identity.listRoles(ctx.tenantId).map((r) => ({
          id: r.id, key: r.key, name: r.name, description: r.description,
          builtin: !!r.is_builtin,
          matrix: matrixFor([r.key]),
        }));
        ctx.ok({ roles, meta: describePermissions() });
      },
    },

    // ── 凭据 ──────────────────────────────────────────────────────────
    {
      id: 'identity.credentials',
      method: 'GET',
      path: '/api/identity/credentials',
      scope: 'admin',
      capability: ['credential:read'],
      summary: '凭据列表（永不回显明文，也不回显密文）',
      handler: (ctx) => {
        ctx.ok({
          credentials: identity.listCredentials(ctx.tenantId),
          note: '服务端只保存密文；明文只在写入时经过一次内存，之后无法取出。',
        });
      },
    },
    {
      id: 'identity.credentials.create',
      method: 'POST',
      path: '/api/identity/credentials',
      scope: 'admin',
      capability: ['credential:write'],
      summary: '写入/更新凭据（AES-256-GCM 加密落库）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const info = identity.setCredential(ctx.tenantId, {
          name: body.name, provider: body.provider || '', value: body.value,
        });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.credential.set', resourceType: 'credential', resourceId: info.id,
          result: 'ok', detail: { name: info.name, provider: info.provider, hasValue: true },
        });
        ctx.json(201, { ok: true, credential: info, note: '凭据已加密存储，接口不会再回显明文。' });
      },
    },
    {
      id: 'identity.credentials.delete',
      method: 'DELETE',
      path: '/api/identity/credentials/:id',
      scope: 'admin',
      capability: ['credential:delete'],
      summary: '删除凭据',
      handler: (ctx) => {
        const r = identity.deleteCredential(ctx.tenantId, ctx.params.id);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.credential.delete', resourceType: 'credential', resourceId: ctx.params.id,
          result: 'ok', detail: {},
        });
        ctx.ok(r);
      },
    },

    // ── API Key（给自动化/集成）──────────────────────────────────────
    {
      id: 'identity.apikeys',
      method: 'GET',
      path: '/api/identity/apikeys',
      scope: 'session',
      summary: '我自己的 API Key 列表（只显示元信息）',
      handler: (ctx) => {
        ctx.ok({
          keys: identity.listApiKeys(ctx.userId),
          note: '明文 key 只在创建时返回一次；服务端只保存它的 HMAC 哈希。',
        });
      },
    },
    {
      id: 'identity.apikeys.create',
      method: 'POST',
      path: '/api/identity/apikeys',
      scope: 'session',
      summary: '创建 API Key（明文只在响应里出现这一次）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const key = identity.createApiKeyFor(ctx.userId, {
          name: body.name,
          scopes: Array.isArray(body.scopes) ? body.scopes : [],
          ttlMs: body.ttlDays ? Number(body.ttlDays) * 86400 * 1000 : null,
        });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.apikey.create', resourceType: 'api_key', resourceId: key.id,
          result: 'ok', detail: { name: key.name, scopes: key.scopes },
        });
        ctx.json(201, { ok: true, apiKey: key });
      },
    },
    {
      id: 'identity.apikeys.revoke',
      method: 'DELETE',
      path: '/api/identity/apikeys/:id',
      scope: 'session',
      summary: '吊销自己的 API Key',
      handler: (ctx) => {
        const r = identity.revokeApiKey(ctx.userId, ctx.params.id);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.apikey.revoke', resourceType: 'api_key', resourceId: ctx.params.id,
          result: 'ok', detail: {},
        });
        ctx.ok(r);
      },
    },

    // ── 两步验证（TOTP，自助）─────────────────────────────────────────
    // 登记 / 停用 / 重发恢复码都要求**现场凭证**（重输口令或动态码）——**不认"仅凭会话"**：
    // 会话被窃者不能替受害者登记自己的验证器，也不能把第二因子拆掉。
    // 流程与安全边界见 identity/service.mjs 的 TOTP 小节。
    {
      id: 'identity.totp.status',
      method: 'GET',
      path: '/api/identity/totp',
      scope: 'session',
      summary: '我的两步验证状态（不含密钥；密钥只在登记响应里出现一次）',
      handler: (ctx) => {
        ctx.ok({
          totp: identity.totpStatus(ctx.userId),
          note: '密钥与恢复码不会在这里回显；恢复码只在登记/重新生成的那一次响应里给出。',
        });
      },
    },
    {
      id: 'identity.totp.enroll',
      method: 'POST',
      path: '/api/identity/totp/enroll',
      scope: 'session',
      summary: '开始登记：重输口令 → 返回密钥与 otpauth URI（确认前不生效）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const enroll = await identity.totpBeginEnroll(ctx.tenantId, ctx.userId, { password: body.password });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.totp.begin', resourceType: 'user', resourceId: ctx.userId,
          result: 'ok', detail: { username: ctx.user.username },
        });
        ctx.ok({ enroll });
      },
    },
    {
      id: 'identity.totp.confirm',
      method: 'POST',
      path: '/api/identity/totp/confirm',
      scope: 'session',
      summary: '确认登记：验证动态码 → 启用 + 一次性恢复码',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const r = await identity.totpConfirmEnroll(ctx.tenantId, ctx.userId, { code: body.code });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.totp.enable', resourceType: 'user', resourceId: ctx.userId,
          result: 'ok', detail: { recoveryCodes: r.recoveryCodes.length },
        });
        ctx.ok(r);
      },
    },
    {
      id: 'identity.totp.disable',
      method: 'POST',
      path: '/api/identity/totp/disable',
      scope: 'session',
      summary: '停用两步验证（口令 + 当前动态码双证；停用是安全降级，不认只凭会话）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const r = await identity.totpDisable(ctx.tenantId, ctx.userId, { password: body.password, code: body.code });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.totp.disable', resourceType: 'user', resourceId: ctx.userId,
          result: 'ok', detail: {},
        });
        ctx.ok(r);
      },
    },
    {
      id: 'identity.totp.recovery-codes',
      method: 'POST',
      path: '/api/identity/totp/recovery-codes',
      scope: 'session',
      summary: '重新生成恢复码（动态码验证；旧码整批作废，明文只出现一次）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const r = identity.totpRegenerateRecoveryCodes(ctx.tenantId, ctx.userId, { code: body.code });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.totp.recovery-regenerate', resourceType: 'user', resourceId: ctx.userId,
          result: 'ok', detail: { count: r.recoveryCodes.length },
        });
        ctx.ok(r);
      },
    },

    // ── 用户组 ────────────────────────────────────────────────────────
    // 组是 `role_bindings` 的第二种主体。在 M1 里只有 `subject_type='user'` 能生效，
    // group 只是 0001 注释里承认过、却无法表达的一种值。这组接口把它补实。
    {
      id: 'identity.groups',
      method: 'GET',
      path: '/api/identity/groups',
      scope: 'admin',
      capability: ['group:read'],
      summary: '用户组列表（含成员数与该组持有的角色）',
      handler: (ctx) => {
        const groups = identity.listGroups(ctx.tenantId);
        ctx.ok({
          groups,
          total: groups.length,
          note: '组上的角色对该组全部成员生效；用户的有效角色 = 直接绑定 ∪ 所属组绑定。',
        });
      },
    },
    {
      id: 'identity.groups.create',
      method: 'POST',
      path: '/api/identity/groups',
      scope: 'admin',
      capability: ['group:write'],
      summary: '新建用户组',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const group = identity.createGroup(ctx.tenantId, { name: body.name, description: body.description });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.group.create', resourceType: 'group', resourceId: group.id,
          result: 'ok', detail: { name: group.name },
        });
        ctx.json(201, { ok: true, group });
      },
    },
    {
      id: 'identity.groups.detail',
      method: 'GET',
      path: '/api/identity/groups/:id',
      scope: 'admin',
      capability: ['group:read'],
      summary: '组详情（角色 + 成员）',
      handler: (ctx) => {
        ctx.ok({ group: identity.describeGroup(ctx.tenantId, ctx.params.id) });
      },
    },
    {
      id: 'identity.groups.update',
      method: 'PUT',
      path: '/api/identity/groups/:id',
      scope: 'admin',
      capability: ['group:write'],
      summary: '改名 / 改描述',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const group = identity.updateGroup(ctx.tenantId, ctx.params.id, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
        });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.group.update', resourceType: 'group', resourceId: group.id,
          result: 'ok', detail: { name: group.name },
        });
        ctx.ok({ group });
      },
    },
    {
      id: 'identity.groups.delete',
      method: 'DELETE',
      path: '/api/identity/groups/:id',
      scope: 'admin',
      capability: ['group:delete'],
      summary: '删除组（连带撤销其角色绑定与成员关系）',
      handler: (ctx) => {
        const r = identity.deleteGroup(ctx.tenantId, ctx.params.id);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.group.delete', resourceType: 'group', resourceId: String(ctx.params.id),
          result: 'ok', detail: { removedMembers: r.removedMembers },
        });
        ctx.ok(r);
      },
    },
    {
      id: 'identity.groups.roles',
      method: 'PUT',
      path: '/api/identity/groups/:id/roles',
      scope: 'admin',
      capability: ['role:write'],
      summary: '设置组持有的角色（整组替换，对其全部成员生效）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const group = identity.setGroupRoles(ctx.tenantId, ctx.params.id, Array.isArray(body.roles) ? body.roles : []);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.group.set-roles', resourceType: 'group', resourceId: group.id,
          result: 'ok', detail: { roles: group.roles, memberCount: group.members.length },
        });
        ctx.ok({ group });
      },
    },
    {
      id: 'identity.groups.members',
      method: 'PUT',
      path: '/api/identity/groups/:id/members',
      scope: 'admin',
      capability: ['group:write'],
      summary: '设置组成员（整组替换；含非本组织成员则整体拒绝）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const group = identity.setGroupMembers(ctx.tenantId, ctx.params.id, Array.isArray(body.userIds) ? body.userIds : []);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.group.set-members', resourceType: 'group', resourceId: group.id,
          result: 'ok', detail: { userIds: group.members.map((m) => m.userId) },
        });
        ctx.ok({ group });
      },
    },

    {
      id: 'identity.groups.members.remove',
      method: 'DELETE',
      path: '/api/identity/groups/:id/members/:userId',
      scope: 'admin',
      capability: ['group:write'],
      summary: '把某个用户移出组（定点移除；不要求先提交整份名单，避免并发编辑互相抹掉）',
      handler: (ctx) => {
        const r = identity.removeGroupMember(ctx.tenantId, ctx.params.id, ctx.params.userId);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId,
          action: 'identity.group.remove-member', resourceType: 'group', resourceId: r.id,
          result: 'ok', detail: { userId: r.userId },
        });
        ctx.ok(r);
      },
    },

    // ── 权限元信息（前端角色页与文档共用，避免与代码漂移）─────────────
    {
      id: 'identity.permissions',
      method: 'GET',
      path: '/api/identity/permissions',
      scope: 'session',
      summary: '权限模型说明（资源、动作、内置角色）',
      handler: (ctx) => {
        ctx.ok({
          meta: describePermissions(),
          builtinRoles: ROLE_KEYS.map((k) => ({ key: k, name: ROLE_MATRIX[k].name, description: ROLE_MATRIX[k].description })),
          mine: matrixFor(ctx.user.roles || []),
        });
      },
    },
  ];

  // 里程碑在路由表上必须显式可查。早先漏标时，`/api/system/routes` 的"按里程碑"
  // 统计里会多出一坨「（未标注）18」—— 那不是如实报告，是把统计变成噪音。
  return routes.map((r) => ({ milestone: 'M1', ...r }));
}
