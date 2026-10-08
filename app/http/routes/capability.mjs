/**
 * 能力分发路由（M4）—— 清单、安装启停、MCP 健康探测、二级可见性治理。
 *
 * 设计要点：
 *   · 清单接口同时给「登记表」（平台治理真相源）与「内核探测」（本机实际有
 *     什么）两个来源，分别标注 —— 两侧不一致不是错误，是两个视角，混在一起
 *     就无法回答"到底有没有"。
 *   · 安装是事务语义：ZIP 解压成功 → 登记；任何一步失败 → 清理半成品 +
 *     审计记 error（验收标准 3：不落半成品）。
 *   · 变更类动作全部落审计链（M3 的红线延续到这里）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ARTIFACT_DIR } from '../../paths.mjs';
import { readJsonBody } from '../context.mjs';
import * as audit from '../../platform/governance/audit.mjs';
import { encryptSecret } from '../../platform/identity/credentials.mjs';
import { readZipEntries, extractZip, zipSync } from '../../util/zip.mjs';
import * as caps from '../../platform/capability/service.mjs';
import { BINDING_LEVELS } from '../../platform/capability/visibility.mjs';
import { parseJsonSafe } from '../../util/json.mjs';
import { nowIso } from '../../util/ids.mjs';

/** Skill 安装根目录：data/storage/skills/<tenant>/<name>/ */
function skillRoot(tenantId) {
  return path.join(ARTIFACT_DIR, 'skills', tenantId);
}

/** 安全路径校验：name 只允许字母数字与连字符（防 ZIP 内路径穿越，见 installSkill）。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 导出/导入的格式串（写出去用规范名）。 */
export const CAPABILITY_FORMAT = 'sti-harness/capabilities';

/**
 * 导入时按**形态**校验而不是等值比对。
 *
 * 为什么：本产品做过一次更名，更名前导出的清单 `format` 是另一个前缀。
 * 写死等值比对会让那些历史清单"导入不认" —— 一次改名废掉已导出的资产。
 * 形态匹配仍然挡得住"随手拿了个 JSON 来导"。
 */
const CAPABILITY_FORMAT_RE = /^[a-z0-9][a-z0-9-]*\/capabilities$/;

export function capabilityRoutes(deps) {
  if (!deps.governance) throw new Error('能力路由装配失败：deps.governance 未提供（审计写入依赖它）');

  return [
    // ── Skill 清单与安装 ──────────────────────────────────────────────
    {
      id: 'capability.skills',
      method: 'GET',
      path: '/api/capability/skills',
      scope: 'admin',
      capability: ['skill:read'],
      milestone: 'M4',
      summary: 'Skill 清单（登记表 + 内核探测双来源；含契约层被闸掉的条目；另附插件清单）',
      handler: async (ctx) => {
        const registry = caps.listSkills(ctx.tenantId).map((r) => ({
          name: r.name, source: r.source, version: r.version, path: r.path,
          enabled: r.enabled === 1, modelInvocable: r.model_invocable === 1,
          installedAt: r.installed_at, meta: parseJsonSafe(r.meta_json),
        }));
        // 内核侧只报 Skill。
        // ⚠️ 两个历史缺陷都在这里，且症状都是"看起来空壳"：
        //    ① 曾经只报 skills，工具区因此永远显示"内核未报告任何工具"；
        //    ② provider 的 listSkills 是 **async**，而这个 handler 曾是同步的
        //       —— 不 await 就取 `r.skills`，拿到的永远是 undefined。于是"内核来源"恒空。
        //
        // ⚠️ 0.21.10：`tools` / `registryTools` / `toolsNote` / `toolsError` / `streamSourced`
        //    全部删除（用户裁定：工具由内核自己调用、没有工具清单这回事）。
        //    详见 0025_drop_tools.sql 与 architecture.md §7.11。
        //    这里**只留真正还在的名词**：Skill（可治理能力）与插件（真实可枚举）。
        let kernel = {
          skills: [], source: '', blocked: [], error: null, pluginCount: null, plugins: [],
        };
        try {
          const r = await deps.kernel.provider.listSkills();
          kernel.skills = (r && r.skills) || [];
          kernel.source = (r && r.source) || '';
        } catch (e) {
          kernel.error = e.message;
        }
        // 插件清单：与 Skill **同批下发但不是同一件事** ——
        // 插件是"装进来的扩展包"（上游 pluginInventory/list 是真实 RPC），
        // 而工具是"内核在回合内的一次调用"（没有清单）。
        // ⚠️ 从前这一段是搭在 `listTools()` 的返回里读出来的 —— 一个叫工具的方法
        //    报的全是插件。0.21.10 把方法正名为 `listPlugins()`，这里跟着改。
        try {
          const p = await deps.kernel.provider.listPlugins();
          kernel.pluginCount = p && p.pluginCount != null ? p.pluginCount : null;
          kernel.plugins = (p && p.plugins) || [];
        } catch { /* 拿不到插件树不该让整页崩：pluginCount 停在 null，前端如实不渲染那一段 */ }
        ctx.ok({
          registry,
          kernel,
          // 口径必须写在响应里随数据一起走，否则前端只能自己编一句 —— 而"编一句"正是
          // 本产品反复吃过亏的地方（三处口径漂移的历史见 architecture.md §10）。
          note: 'registry = 平台登记（治理真相源）；kernel = 内核本机探测。两者不一致是常态：登记了未安装、或安装了未登记，各自如实标注。',
        });
      },
    },

    {
      id: 'capability.skills.install',
      method: 'POST',
      path: '/api/capability/skills/install',
      scope: 'admin',
      capability: ['skill:write'],
      milestone: 'M4',
      summary: '从 ZIP 包安装 Skill（解压 → 登记，失败即回滚并记审计）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const name = String(body.name || '').trim();
        const zipBase64 = String(body.zipBase64 || '');
        if (!NAME_RE.test(name)) {
          ctx.json(400, { ok: false, error: { code: 'bad_request', message: 'name 只允许字母/数字/点/连字符（1-64 位）' } });
          return;
        }
        if (!zipBase64) {
          ctx.json(400, { ok: false, error: { code: 'bad_request', message: 'zipBase64 必填（ZIP 包的 base64 编码）' } });
          return;
        }
        let buf;
        try { buf = Buffer.from(zipBase64, 'base64'); } catch { buf = null; }
        if (!buf || buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
          ctx.json(400, { ok: false, error: { code: 'bad_request', message: '不是有效的 ZIP 数据（缺本地文件头签名）' } });
          return;
        }

        // 预检：先读条目清单，路径穿越/绝对路径一律拒绝 —— 不落半成品的第一道闸
        let entries;
        try { entries = readZipEntries(buf); } catch (e) {
          ctx.json(400, { ok: false, error: { code: 'bad_request', message: 'ZIP 结构损坏：' + e.message } });
          return;
        }
        if (!entries.length) {
          ctx.json(400, { ok: false, error: { code: 'bad_request', message: 'ZIP 是空的' } });
          return;
        }
        const traversal = entries.find((e) => e.name.startsWith('/') || e.name.includes('..') || /^[A-Za-z]:/.test(e.name));
        if (traversal) {
          audit.append({
            tenantId: ctx.tenantId, userId: ctx.userId || null,
            action: 'capability.skill.install', resourceType: 'skill', resourceId: name,
            result: 'denied', detail: { reason: 'zip_path_traversal', entry: traversal.name },
          });
          ctx.json(400, { ok: false, error: { code: 'bad_request', message: 'ZIP 内存在路径穿越条目（' + traversal.name + '），已拒绝 —— 这是安全边界，不是解析错误' } });
          return;
        }

        const dest = path.join(skillRoot(ctx.tenantId), name);
        const rollback = () => { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 尽力清理 */ } caps.unregisterSkill(ctx.tenantId, name); };
        try {
          fs.mkdirSync(dest, { recursive: true });
          extractZip(buf, dest);
          const reg = caps.registerSkill(ctx.tenantId, {
            name, source: 'zip', version: String(body.version || ''),
            path: dest, enabled: body.enabled !== false,
            meta: { files: entries.length, installedFrom: 'api', installedSnapshot: caps.snapshotSkillDir(dest) },
          });
          audit.append({
            tenantId: ctx.tenantId, userId: ctx.userId || null,
            action: 'capability.skill.install', resourceType: 'skill', resourceId: name,
            result: 'ok', detail: { files: entries.length, dest, version: reg.version },
          });
          ctx.ok({ skill: reg, files: entries.length });
        } catch (e) {
          rollback();
          audit.append({
            tenantId: ctx.tenantId, userId: ctx.userId || null,
            action: 'capability.skill.install', resourceType: 'skill', resourceId: name,
            result: 'error', detail: { error: e.message, rolledBack: true },
          });
          ctx.json(500, { ok: false, error: { code: 'install_failed', message: '安装失败，已回滚（不落半成品）：' + e.message } });
        }
      },
    },

    {
      id: 'capability.skills.enabled',
      method: 'POST',
      path: '/api/capability/skills/:name/enabled',
      scope: 'admin',
      capability: ['skill:write'],
      milestone: 'M4',
      summary: '启用/停用 Skill（不重启进程，契约层立即生效）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const enabled = !!body.enabled;
        const ok = caps.setSkillEnabled(ctx.tenantId, ctx.params.name, enabled);
        if (!ok) {
          ctx.json(404, { ok: false, error: { code: 'not_found', message: 'Skill 未登记：' + ctx.params.name } });
          return;
        }
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'capability.skill.enabled', resourceType: 'skill', resourceId: String(ctx.params.name),
          result: 'ok', detail: { enabled },
        });
        ctx.ok({ name: ctx.params.name, enabled });
      },
    },

    {
      id: 'capability.skills.checkUpdate',
      method: 'POST',
      path: '/api/capability/skills/:name/check-update',
      scope: 'admin',
      capability: ['skill:read'],
      milestone: 'M4',
      summary: '更新检测：现算安装目录快照与安装时比对（unchanged/changed/missing/not_checkable）',
      handler: (ctx) => {
        const r = caps.checkSkillUpdate(ctx.tenantId, ctx.params.name);
        if (r.status === 'not_checkable' && r.detail.startsWith('Skill 未登记')) {
          ctx.json(404, { ok: false, error: { code: 'not_found', message: r.detail } });
          return;
        }
        if (r.status !== 'unchanged') {
          audit.append({
            tenantId: ctx.tenantId, userId: ctx.userId || null,
            action: 'capability.skill.checkUpdate', resourceType: 'skill', resourceId: String(ctx.params.name),
            result: r.status === 'missing' || r.status === 'changed' ? 'error' : 'ok',
            detail: { status: r.status },
          });
        }
        ctx.ok({ name: ctx.params.name, ...r, note: '检测对象是平台磁盘上的安装目录；"上游出新版本"需要市场/导入源配合（M4-3），现在做不到就不装作做得到' });
      },
    },

    {
      id: 'capability.skills.remove',
      method: 'DELETE',
      path: '/api/capability/skills/:name',
      scope: 'admin',
      capability: ['skill:write'],
      milestone: '0.18.0',
      summary: '卸载 Skill：zip 来源连同安装目录一并删除；本机目录引用/导入只注销登记、不碰用户目录（不可逆，想留着请用停用）',
      handler: (ctx) => {
        const name = String(ctx.params.name || '');
        const row = caps.getSkill(ctx.tenantId, name);
        if (!row) {
          ctx.json(404, { ok: false, error: { code: 'not_found', message: 'Skill 未登记：' + name } });
          return;
        }
        let dirRemoved = false;
        let note;
        if (row.source === 'zip') {
          const root = path.resolve(skillRoot(ctx.tenantId));
          const dest = row.path ? path.resolve(row.path) : '';
          if (!dest) note = '登记里没有安装路径（可能由旧版本登记），只注销了登记';
          else if (dest === root || !dest.startsWith(root + path.sep)) note = '安装路径不在本租户 Skill 目录内，为安全起见未删目录，只注销了登记';
          else if (!fs.existsSync(dest)) note = '安装目录已不存在（可能被手动清理过），只注销了登记';
          else {
            try {
              fs.rmSync(dest, { recursive: true, force: true });
              dirRemoved = true;
              note = '安装目录已随卸载删除';
            } catch (e) {
              // 删目录失败就不注销登记 —— 保持"登记与磁盘一致"，不落半成品
              audit.append({
                tenantId: ctx.tenantId, userId: ctx.userId || null,
                action: 'capability.skill.remove', resourceType: 'skill', resourceId: name,
                result: 'error', detail: { error: e.message, registrationKept: true },
              });
              ctx.json(500, { ok: false, error: { code: 'remove_failed', message: '安装目录删除失败，登记保留（可修复后重试）：' + e.message } });
              return;
            }
          }
        } else {
          note = '来源为 ' + row.source + '（非平台落盘内容，卸载不碰其目录）—— 只注销了登记，未删除任何目录';
        }
        caps.unregisterSkill(ctx.tenantId, name);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'capability.skill.remove', resourceType: 'skill', resourceId: name,
          result: 'ok', detail: { source: row.source, dirRemoved, path: row.path || '' },
        });
        ctx.ok({ removed: true, name, source: row.source, dirRemoved, note });
      },
    },

    // ── Tools：整块删除（0.21.10）─────────────────────────────────────
    //    这里从前有 `POST /api/capability/tools/:name/enabled`（启用/停用工具）。
    //    随"工具登记表"一起删除 —— 用户裁定：「工具是在内核自己调用，不用单独写这个能力，
    //    而且不会单独列出来有哪些工具」。既然没有清单、也没有可登记的对象，
    //    就不存在"停用某个工具"这个动作。详见 ../data/migrations/0025_drop_tools.sql。
    //    ⚠️ 路由整体消失（不是留一个恒 404 的空壳）：契约面的路由数会进
    //       tools/audit-coverage.mjs 的对账，留一个没人能成功调用的端点等于
    //       给覆盖率审计留一条永远测不到的路由。

    // ── MCP servers ───────────────────────────────────────────────────
    {
      id: 'capability.mcp',
      method: 'GET',
      path: '/api/capability/mcp',
      scope: 'admin',
      capability: ['mcp:read'],
      milestone: 'M4',
      summary: 'MCP 服务清单与健康状态（登记表 + 内核探测双来源）',
      handler: async (ctx) => {
        const registry = caps.listMcpServers(ctx.tenantId).map((r) => ({
          name: r.name, transport: r.transport, enabled: r.enabled === 1,
          health: r.health, healthDetail: r.health_detail || '', healthAt: r.health_at || '',
          hasConfig: !!r.config_cipher,
        }));
        // ⚠️ listMcpServers 是 async —— 不 await 会拿到 Promise，`r.servers` 恒为 undefined，
        //    "内核来源"因此一直是空的（与上面 skills 路由同一类缺陷）。
        let kernel = { servers: [], blocked: [], source: '', error: null };
        try {
          const r = await deps.kernel.provider.listMcpServers();
          kernel = {
            servers: (r && r.servers) || [], blocked: (r && r.blocked) || [],
            source: (r && r.source) || '', error: null,
          };
        } catch (e) { kernel.error = e.message; }
        ctx.ok({
          registry,
          kernel,
          note: 'health = unknown（还没探过）/ ok / error（详情见 healthDetail）；探测请用 POST /api/capability/mcp/:name/probe',
        });
      },
    },

    {
      id: 'capability.mcp.upsert',
      method: 'POST',
      path: '/api/capability/mcp',
      scope: 'admin',
      capability: ['mcp:write'],
      milestone: 'M4',
      summary: '登记/更新 MCP 服务（连接配置 AES-256-GCM 加密落库）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        const name = String(body.name || '').trim();
        if (!NAME_RE.test(name)) {
          ctx.json(400, { ok: false, error: { code: 'bad_request', message: 'name 只允许字母/数字/点/连字符（1-64 位）' } });
          return;
        }
        const configCipher = body.config ? encryptSecret(JSON.stringify(body.config), deps.masterSecret) : '';
        const row = caps.registerMcpServer(ctx.tenantId, {
          name, transport: String(body.transport || 'stdio'), configCipher, enabled: body.enabled !== false,
        });
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'capability.mcp.upsert', resourceType: 'mcp', resourceId: name,
          result: 'ok', detail: { transport: row.transport, hasConfig: !!body.config },
        });
        ctx.ok({ server: { name: row.name, transport: row.transport, enabled: row.enabled === 1, health: row.health } });
      },
    },

    {
      id: 'capability.mcp.probe',
      method: 'POST',
      path: '/api/capability/mcp/:name/probe',
      scope: 'admin',
      capability: ['mcp:write'],
      milestone: 'M4',
      summary: '立即健康探测（http/sse 真 TCP 连接；stdio 验证命令可执行；探不了如实说明）',
      handler: async (ctx) => {
        const row = caps.getMcpServer(ctx.tenantId, ctx.params.name);
        if (!row) {
          ctx.json(404, { ok: false, error: { code: 'not_found', message: 'MCP 服务未登记：' + ctx.params.name } });
          return;
        }
        const r = await caps.probeMcpServer(row, deps.decryptMcpConfig || null);
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'capability.mcp.probe', resourceType: 'mcp', resourceId: row.name,
          result: r.health === 'ok' ? 'ok' : r.health === 'error' ? 'error' : 'ok',
          detail: { health: r.health, detail: r.detail },
        });
        ctx.ok(r);
      },
    },

    {
      id: 'capability.mcp.enabled',
      method: 'PATCH',
      path: '/api/capability/mcp/:name',
      scope: 'admin',
      capability: ['mcp:write'],
      milestone: 'M4',
      summary: '启用/停用 MCP 服务（停用后内核不再拉起它，登记记录与健康历史保留）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        // ⚠️ 只认布尔：`enabled: 0` / `'false'` 这类"看起来像假值"的东西一律 400。
        //    静默按真值处理会让"我明明传了 false 怎么还开着"变成一个查不出来的问题。
        if (typeof body.enabled !== 'boolean') {
          ctx.json(400, { ok: false, error: { code: 'bad_request', message: 'enabled 必须是布尔值（true / false）' } });
          return;
        }
        const hit = caps.setMcpEnabled(ctx.tenantId, ctx.params.name, body.enabled);
        if (!hit) {
          ctx.json(404, { ok: false, error: { code: 'not_found', message: 'MCP 服务未登记：' + ctx.params.name } });
          return;
        }
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'capability.mcp.enabled', resourceType: 'mcp', resourceId: String(ctx.params.name),
          result: 'ok', detail: { enabled: body.enabled },
        });
        ctx.ok({ name: ctx.params.name, enabled: body.enabled });
      },
    },

    {
      id: 'capability.mcp.remove',
      method: 'DELETE',
      path: '/api/capability/mcp/:name',
      scope: 'admin',
      capability: ['mcp:write'],
      milestone: 'M4',
      summary: '注销 MCP 服务（连同加密的连接配置一并删除；不可逆，只是不再使用请改用停用）',
      handler: (ctx) => {
        const hit = caps.removeMcpServer(ctx.tenantId, ctx.params.name);
        if (!hit) {
          ctx.json(404, { ok: false, error: { code: 'not_found', message: 'MCP 服务未登记：' + ctx.params.name } });
          return;
        }
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'capability.mcp.remove', resourceType: 'mcp', resourceId: String(ctx.params.name),
          result: 'ok', detail: {},
        });
        ctx.ok({ removed: true, name: ctx.params.name });
      },
    },

    // ── 导入导出（M4-3，验收标准 4：脱敏由脚本扫描断言） ──────────────
    {
      id: 'capability.export',
      method: 'GET',
      path: '/api/capability/export',
      scope: 'admin',
      capability: ['capability:read'],
      milestone: 'M4',
      summary: '导出能力清单（脱敏：MCP 连接配置绝不导出；zip 来源的 Skill 重打包随行）',
      handler: (ctx) => {
        const out = {
          format: CAPABILITY_FORMAT,
          formatVersion: 1,
          exportedAt: nowIso(),
          tenant: ctx.tenantId,
          skills: [],
          // ⚠️ 0.21.10：`tools: []` 字段删除（工具登记表已删）。
          //    导出的东西必须都能导回来 —— 留一个恒空的 tools 字段，导入端会以为
          //    "这次导出恰好没有工具"，而事实是"工具不再是一个可导出的概念"。
          mcp: [],
          bindings: caps.listBindings(ctx.tenantId).map(({ id, tenant_id, ...rest }) => ({ subjectType: rest.subject_type, subjectId: rest.subject_id, capabilityType: rest.capability_type, capabilityId: rest.capability_id, allow: rest.allow })),
        };
        for (const s of caps.listSkills(ctx.tenantId)) {
          let zipBase64 = null;
          let note = '';
          if (s.source === 'zip' && s.path && fs.existsSync(s.path)) {
            try { zipBase64 = zipSync(caps.packSkillDir(s.path)).toString('base64'); }
            catch (e) { note = '重打包失败：' + e.message; }
          } else if (s.source !== 'zip') {
            note = '来源为本机目录引用，内容不随清单导出 —— 导入端需自行准备目录';
          }
          out.skills.push({
            name: s.name, source: s.source, version: s.version,
            enabled: s.enabled === 1, modelInvocable: s.model_invocable === 1,
            zipBase64, note,
          });
        }
        for (const m of caps.listMcpServers(ctx.tenantId)) {
          // 脱敏红线：config_cipher 是 AES 密文，解开后就是连接密钥 ——
          // 跨部署导出绝不携带，导入端必须重新配置（导出里如实留 note 说明）
          out.mcp.push({
            name: m.name, transport: m.transport, enabled: m.enabled === 1,
            config: null, note: '连接配置含密钥，不随清单导出；导入后请重新配置（POST /api/capability/mcp）',
          });
        }
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'capability.export', resourceType: 'capability', resourceId: '',
          result: 'ok', detail: { skills: out.skills.length, mcp: out.mcp.length, bindings: out.bindings.length },
        });
        ctx.ok(out);
      },
    },

    {
      id: 'capability.import',
      method: 'POST',
      path: '/api/capability/import',
      scope: 'admin',
      capability: ['capability:write'],
      milestone: 'M4',
      summary: '导入能力清单（upsert 语义：同名覆盖；MCP 连接配置需导入后补配）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        if (!body || !CAPABILITY_FORMAT_RE.test(String(body.format || ''))) {
          ctx.json(400, { ok: false, error: { code: 'bad_request', message: '不是本平台的导出格式（format 应为 <产品名>/capabilities）' } });
          return;
        }
        // ⚠️ 0.21.10：`tools` 计数删除。
        //    向后兼容（很重要）：**旧导出包里可能有 `body.tools`**，这里必须
        //    **静默收下、不报错** —— 导入的语义是"把这份清单装进来"，
        //    遇到一个本版本已不存在的段落，正确反应是忽略它，
        //    而不是让整包导入失败（用户会读成"导入功能坏了"）。
        //    所以下面没有"未知字段就报错"的校验 —— 这是有意的宽容，别当成遗漏。
        const result = { skills: { installed: 0, failed: [] }, mcp: 0, bindings: 0 };
        for (const s of Array.isArray(body.skills) ? body.skills : []) {
          try {
            if (s.zipBase64) {
              const buf = Buffer.from(String(s.zipBase64), 'base64');
              if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error(s.name + '：zipBase64 不是有效 ZIP');
              const dest = path.join(skillRoot(ctx.tenantId), String(s.name).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_'));
              fs.rmSync(dest, { recursive: true, force: true });
              fs.mkdirSync(dest, { recursive: true });
              extractZip(buf, dest);
              caps.registerSkill(ctx.tenantId, {
                name: s.name, source: 'zip', version: String(s.version || ''), path: dest,
                enabled: s.enabled !== false, modelInvocable: s.modelInvocable !== false,
                meta: { files: caps.packSkillDir(dest).length, installedFrom: 'import', installedSnapshot: caps.snapshotSkillDir(dest) },
              });
              result.skills.installed++;
            } else {
              caps.registerSkill(ctx.tenantId, {
                name: s.name, source: 'import', version: String(s.version || ''), path: '',
                enabled: s.enabled !== false, modelInvocable: s.modelInvocable !== false,
                meta: { importNote: s.note || '清单导入（无内容）' },
              });
              result.skills.installed++;
            }
          } catch (e) {
            result.skills.failed.push({ name: s.name, error: e.message });
          }
        }
        for (const m of Array.isArray(body.mcp) ? body.mcp : []) {
          caps.registerMcpServer(ctx.tenantId, { name: m.name, transport: String(m.transport || 'stdio'), configCipher: '', enabled: m.enabled !== false });
          result.mcp++;
        }
        for (const b of Array.isArray(body.bindings) ? body.bindings : []) {
          try {
            caps.setBinding(ctx.tenantId, {
              subjectType: String(b.subjectType || 'tenant'), subjectId: b.subjectId,
              capabilityType: String(b.capabilityType || ''), capabilityId: String(b.capabilityId || ''),
              allow: Number(b.allow) === 0 ? 0 : 1,
            });
            result.bindings++;
          } catch { /* 单条坏绑定不挡整包导入；绑定可以在页面上重设 */ }
        }
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'capability.import', resourceType: 'capability', resourceId: '',
          result: result.skills.failed.length ? 'error' : 'ok',
          detail: result,
        });
        ctx.ok({ imported: result, note: 'MCP 连接配置不随清单导出 —— 导入的服务需要重新配置后才能探测' });
      },
    },

    // ── 二级可见性治理（0.21.10：三级 → 二级，去掉 tool 那一层）────────────
    {
      id: 'capability.policies',
      method: 'GET',
      path: '/api/capability/policies',
      scope: 'admin',
      capability: ['capability:read'],
      milestone: 'M4',
      summary: '可见性治理规则（二级 allow/deny 绑定）+ 当前生效统计',
      handler: (ctx) => {
        ctx.ok({
          bindings: caps.listBindings(ctx.tenantId),
          stats: caps.stats(ctx.tenantId),
          levels: BINDING_LEVELS,
          semantics: {
            precedence: 'deny 永远赢（任一层 deny 即不可见）→ 登记开关（enabled=0）→ 默认放行',
            scope: '绑定按 tenant/user/role 三个主体维度生效；契约层 gate 用保守并集（任一租户收紧即生效）—— per-tenant 精确隔离在 M5',
            // ⚠️ 0.21.10：`levels` 里不再有 `tool`。接口把 `levels` 直接下发，
            //    所以前端的层级下拉是**照着它渲染**的 —— 服务端一删，界面自然跟着少一项，
            //    不需要前端再写一份"哪些层级可用"的清单（那必然漂）。
          },
        });
      },
    },

    {
      id: 'capability.bindings.set',
      method: 'POST',
      path: '/api/capability/bindings',
      scope: 'admin',
      capability: ['capability:write'],
      milestone: 'M4',
      summary: '设置一条 allow/deny 绑定（同主体同能力重复设置即覆盖）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        let b;
        try {
          b = caps.setBinding(ctx.tenantId, {
            subjectType: String(body.subjectType || 'tenant'),
            subjectId: body.subjectId,
            capabilityType: String(body.capabilityType || ''),
            capabilityId: String(body.capabilityId || ''),
            allow: body.allow,
          });
        } catch (e) {
          ctx.json(400, { ok: false, error: { code: 'bad_request', message: e.message } });
          return;
        }
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'capability.binding.set', resourceType: 'binding', resourceId: b.id,
          result: 'ok',
          detail: { subjectType: b.subject_type, subjectId: b.subject_id, capabilityType: b.capability_type, capabilityId: b.capability_id, allow: b.allow },
        });
        ctx.ok({ binding: b });
      },
    },

    {
      id: 'capability.bindings.remove',
      method: 'DELETE',
      path: '/api/capability/bindings/:id',
      scope: 'admin',
      capability: ['capability:write'],
      milestone: 'M4',
      summary: '删除一条绑定（回到默认放行/登记开关决定的状态）',
      handler: (ctx) => {
        const ok = caps.removeBinding(ctx.tenantId, ctx.params.id);
        if (!ok) {
          ctx.json(404, { ok: false, error: { code: 'not_found', message: '绑定不存在（或已删除）' } });
          return;
        }
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'capability.binding.remove', resourceType: 'binding', resourceId: String(ctx.params.id),
          result: 'ok', detail: {},
        });
        ctx.ok({ removed: true });
      },
    },

    {
      id: 'capability.bindings.update',
      method: 'PUT',
      path: '/api/capability/bindings/:id',
      scope: 'admin',
      capability: ['capability:write'],
      milestone: '0.16.0',
      summary: '翻转一条绑定的判定（allow ⇄ deny；主体与能力是绑定身份，不在此改）',
      handler: async (ctx) => {
        const body = await readJsonBody(ctx.req);
        // 只认布尔（与 MCP enabled 同一条纪律）：`0` / `'false'` 这类一律 400。
        if (typeof body.allow !== 'boolean') {
          ctx.json(400, { ok: false, error: { code: 'bad_request', message: 'allow 必须是布尔值（true = 放行 / false = 拒绝）' } });
          return;
        }
        let row;
        try {
          row = caps.setBindingAllow(ctx.tenantId, ctx.params.id, body.allow ? 1 : 0);
        } catch (e) {
          ctx.json(400, { ok: false, error: { code: 'bad_request', message: e.message } });
          return;
        }
        if (!row) {
          ctx.json(404, { ok: false, error: { code: 'not_found', message: '绑定不存在（或不属于当前组织）' } });
          return;
        }
        audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action: 'capability.binding.update', resourceType: 'binding', resourceId: String(ctx.params.id),
          result: 'ok',
          detail: { allow: row.allow, subjectType: row.subject_type, capabilityType: row.capability_type, capabilityId: row.capability_id },
        });
        ctx.ok({ binding: row });
      },
    },
  ];
}
