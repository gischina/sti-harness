/**
 * 身份与权限 —— 业务编排层。
 *
 * 这一层是**唯一**把「口令 / 令牌 / 凭据 / 角色」拼成流程的地方。它负责：
 *   · 初始化向导：空库 → 建组织 + 内置角色 + 管理员 + 可选模型凭据
 *   · 登录 / 登出 / 令牌校验（含 API Key）
 *   · 账号与角色的增删查
 *   · 凭据的写入（加密）与列表（永不解密返回）
 *
 * 依赖注入 `masterSecret`（来自 `data/.secret`）而不是自己去读文件，
 * 这样测试可以注入固定密钥，装配层也只有一个地方碰密钥文件。
 *
 * ⚠️ 两个安全细节，改动时务必保留：
 *   1. 登录失败**不区分**「用户不存在」与「口令错误」，且两者耗时接近 ——
 *      否则登录接口会变成账号枚举器。
 *   2. 校验令牌走 `HMAC(masterSecret, token)` 再查表；库里的哈希**不能**直接当令牌用。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { tx } from '../../data/db.mjs';
import { errors, AppError } from '../../util/errors.mjs';
import { parseCsvRecords } from '../../util/csv.mjs';
import * as orgRepo from './repos/orgs.mjs';
import * as userRepo from './repos/users.mjs';
import * as roleRepo from './repos/roles.mjs';
import * as groupRepo from './repos/groups.mjs';
import * as sessionRepo from './repos/authSessions.mjs';
import * as lockoutRepo from './repos/loginLockout.mjs';
import * as apiKeyRepo from './repos/apiKeys.mjs';
import * as credRepo from './repos/credentials.mjs';
import * as totpRepo from './repos/totp.mjs';
import { hashPassword, verifyPassword, checkPasswordStrength, kdfInfo } from './passwords.mjs';
import { issueSessionToken, issueApiKey, issueChallengeTicket, hashToken, SESSION_PREFIX, APIKEY_PREFIX, CHALLENGE_PREFIX } from './tokens.mjs';
import { encryptSecret, decryptSecret, credentialInfo, cryptoInfo } from './credentials.mjs';
import { generateSecret, verifyTotp, otpauthUri, generateRecoveryCodes, recoveryCodeHash, TOTP_DIGITS, TOTP_PERIOD_SEC } from './totp.mjs';
import { ROLE_KEYS, knownRole } from './permissions.mjs';

const DEFAULT_TTL_MS = 8 * 3600 * 1000;

/** 两步登录票据：5 分钟有效期、最多 5 次验证尝试（爆破上限靠它 + 账号退避，见 TOTP 小节） */
const TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TOTP_CHALLENGE_MAX_ATTEMPTS = 5;

/**
 * 账号批量导入（POST /api/identity/users/import）的硬上限。
 * 口令哈希是刻意做慢的（scrypt 约 50ms/次，见 passwords.mjs），500 行 ≈ 25s+
 * 已是单请求的容忍极限；**上限必须在任何哈希之前检查** ——
 * 否则恶意（或误传）的大文件会把进程拖住十几分钟，请求还没超时就把服务占满。
 */
const IMPORT_MAX_ROWS = 500;

/** 导入 CSV 的表头别名（大小写不敏感；中文别名来自 Excel 用户的实际习惯） */
const IMPORT_COLUMNS = {
  username: ['username', '账号', '用户名'],
  password: ['password', '口令', '密码'],
  displayName: ['displayname', '姓名', '显示名'],
  dept: ['dept', 'department', '部门'],
  roles: ['roles', 'role', '角色'],
};

/** 组织 slug：把名称转成 URL 安全的小写短标识（中文名无法直接转，用随机后缀兜底） */
function slugify(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (base) return base.slice(0, 40);
  return 'org-' + Math.random().toString(36).slice(2, 8);
}

export function createIdentityService({ masterSecret, sessionTtlMs = DEFAULT_TTL_MS } = {}) {
  if (!masterSecret) throw new Error('createIdentityService 需要 masterSecret');

  // ── 登录失败退避（爆破防护的第二道闸）────────────────────────────────
  //
  // 第一道闸在 `http/middleware/registry.mjs`：登录路由按 IP 单独收紧（默认 30 次/分钟）。
  // 但它按 IP 计数 —— 攻击者换 IP（代理池）就能绕过。这里按**账号**再上一道：
  // 同一 (组织, 账号) 连续失败达到阈值后，**指数退避**（30s 起、每次翻倍、封顶 15 分钟）。
  //
  // 2026-10 安全评审 P0-4：状态已从进程内 Map 迁到 `login_lockout` 表（迁移 0018），
  // 进程重启不再清零。语义保持不变的三条边界（改动时务必保留）：
  //    · 这是**退避**不是**永久锁定**：窗口很短，故意让"拿别人的账号名去撞"造成的
  //      DoS 代价可控；
  //    · 对**不存在**的账号也计数（行为与存在账号完全一致）—— 否则"哪些账号会被锁"
  //      本身就是一个账号枚举信号，会把 service 顶部那条"不区分用户是否存在"的努力抵消掉；
  //    · 锁定期不单独暴露：登录入口仍统一返回"账号或口令不正确"，锁定由 429 单独体现。
  const LOGIN_FAIL_MAX = Number(process.env.STI_LOGIN_FAIL_MAX || 5);
  const LOGIN_LOCK_BASE_MS = Number(process.env.STI_LOGIN_LOCK_BASE_MS || 30_000);
  const LOGIN_LOCK_CAP_MS = Number(process.env.STI_LOGIN_LOCK_CAP_MS || 900_000);

  function lockStatus(orgId, username, now = Date.now()) {
    const row = lockoutRepo.getLockout(orgId, username);
    if (!row) return { locked: false, count: 0, retryAfterMs: 0 };
    const until = row.locked_until ? Date.parse(row.locked_until) : 0;
    if (until && until > now) {
      return { locked: true, count: Number(row.fail_count), retryAfterMs: until - now };
    }
    return { locked: false, count: Number(row.fail_count), retryAfterMs: 0 };
  }

  function recordLoginFailure(orgId, username, now = Date.now()) {
    const current = lockStatus(orgId, username, now);
    const count = current.count + 1;
    let lockedUntil = null;
    if (count >= LOGIN_FAIL_MAX) {
      // 第 5 次失败锁 30s、第 6 次 60s…… 封顶 15 分钟。`over` = 超过阈值的次数。
      const over = count - LOGIN_FAIL_MAX;
      lockedUntil = new Date(now + Math.min(LOGIN_LOCK_BASE_MS * 2 ** over, LOGIN_LOCK_CAP_MS))
        .toISOString();
    }
    lockoutRepo.upsertLockout(orgId, username, { failCount: count, lockedUntil });
    return { count, lockedUntil };
  }

  function clearLoginFailures(orgId, username) {
    lockoutRepo.clearLockout(orgId, username);
  }

  // ── 初始化状态 ───────────────────────────────────────────────────────
  function setupStatus() {
    const orgCount = orgRepo.countOrgs();
    const org = orgCount ? orgRepo.listOrgs()[0] : null;
    return {
      initialized: orgCount > 0 && !!org && userRepo.countUsers(org.id) > 0,
      orgCount,
      org: org ? { id: org.id, name: org.name, slug: org.slug } : null,
      userCount: org ? userRepo.countUsers(org.id) : 0,
      /** 是否需要走初始化向导 */
      needsSetup: !(orgCount > 0 && org && userRepo.countUsers(org.id) > 0),
    };
  }

  function requireSetup() {
    const st = setupStatus();
    if (st.needsSetup) {
      throw new AppError('setup_required',
        '平台尚未初始化：请先访问初始化向导建立组织与管理员账号。', 409,
        { needsSetup: true });
    }
    return st;
  }

  function status() {
    const st = setupStatus();
    const orgId = st.org ? st.org.id : null;
    return {
      initialized: st.initialized,
      orgs: st.orgCount,
      users: orgId ? userRepo.countUsers(orgId) : 0,
      departments: orgId ? orgRepo.countDepartments(orgId) : 0,
      groups: orgId ? groupRepo.countGroups(orgId) : 0,
      roles: orgId ? roleRepo.countRoles(orgId) : 0,
      credentials: orgId ? credRepo.countCredentials(orgId) : 0,
      activeSessions: sessionRepo.countActive(),
      kdf: kdfInfo(),
      crypto: cryptoInfo(),
      builtinRoles: ROLE_KEYS.slice(),
      // 登录爆破防护的第二道闸（第一道是限流中间件的按 IP 收紧）——边界随数据一起报出
      loginGuard: {
        accountFailMax: LOGIN_FAIL_MAX,
        lockBaseMs: LOGIN_LOCK_BASE_MS,
        lockCapMs: LOGIN_LOCK_CAP_MS,
        scope: 'persisted',
        note: '同一账号连续失败 ' + LOGIN_FAIL_MAX + ' 次起指数退避（'
          + (LOGIN_LOCK_BASE_MS / 1000) + 's 起翻倍，封顶 ' + (LOGIN_LOCK_CAP_MS / 60000) + ' 分钟）；'
          + '状态持久化在 login_lockout 表（迁移 0018），进程重启不清零、登录成功即删除。'
          + 'IP 侧另有独立限流（默认 30 次/分钟，STI_RATE_LIMIT_LOGIN 可调）。',
      },
    };
  }

  // ── 初始化向导 ───────────────────────────────────────────────────────

  /**
   * 从空库建起：组织 + 内置角色 + 管理员 + 可选模型凭据。
   *
   * 迁移与角色物化是同步 SQL，口令哈希在事务**之外**先算好 ——
   * 因为 `tx()` 是同步的，而 scrypt 是异步的（不能把 await 塞进同步事务回调）。
   */
  async function runSetup({ orgName, adminUsername, adminPassword, adminDisplayName, credential = null } = {}) {
    if (orgRepo.countOrgs() > 0) {
      throw errors.conflict('平台已经初始化过（已存在组织）。如需新建组织请用管理员账号操作。');
    }
    const name = String(orgName || '').trim();
    if (!name) throw errors.badRequest('组织名称不能为空');

    const username = String(adminUsername || '').trim();
    if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) {
      throw errors.badRequest('管理员账号需为 2–64 位的字母、数字或 . _ - @ 组合');
    }
    const strength = checkPasswordStrength(adminPassword);
    if (!strength.ok) throw errors.badRequest('管理员口令不符合要求：' + strength.reason);

    // 先算哈希（异步，事务外）
    const pwd = await hashPassword(adminPassword);

    // 凭据密文（异步无关，但也在事务外准备好）
    let cipher = null;
    if (credential && credential.name) {
      if (!credential.value) throw errors.badRequest('模型凭据的值不能为空');
      cipher = encryptSecret(credential.value, masterSecret);
    }

    const created = tx(() => {
      const org = orgRepo.createOrg({ name, slug: slugify(name) });
      const roles = roleRepo.ensureBuiltinRoles(org.id);
      const user = userRepo.createUser({
        orgId: org.id,
        username,
        displayName: String(adminDisplayName || username),
        pwdHash: pwd.hash,
        pwdSalt: pwd.salt,
      });
      const owner = roleRepo.getRoleByKey(org.id, 'owner');
      roleRepo.bindRole({ subjectType: 'user', subjectId: user.id, roleId: owner.id, scopeType: 'tenant' });

      let cred = null;
      if (cipher) {
        const cid = credRepo.upsertCredential({
          orgId: org.id,
          name: String(credential.name),
          provider: String(credential.provider || ''),
          cipher,
        });
        // 用"带 cipher 的"查询，这样 credentialInfo 才能如实报出 hasValue:true
        // （列表查询刻意不带 cipher，不能拿它来判定"有没有值"）
        cred = credRepo.getCredentialForUseById(org.id, cid);
      }
      return { org, roles, user, cred };
    });

    return {
      ok: true,
      org: { id: created.org.id, name: created.org.name, slug: created.org.slug },
      rolesCreated: created.roles,
      admin: {
        id: created.user.id,
        username: created.user.username,
        displayName: created.user.display_name,
        roles: ['owner'],
      },
      credential: created.cred ? credentialInfo(created.cred) : null,
      next: '现在可以用该账号登录：POST /api/identity/login',
    };
  }

  // ── 登录 / 校验 / 登出 ───────────────────────────────────────────────

  /** 解析目标组织：显式 slug 优先；只有一个组织时直接用它；多个则要求指明（不猜） */
  function resolveOrg(orgSlug) {
    if (orgSlug) {
      const o = orgRepo.getOrgBySlug(orgSlug);
      if (!o) throw errors.unauthorized('账号、口令或组织不匹配');
      return o;
    }
    const all = orgRepo.listOrgs();
    if (all.length === 1) return all[0];
    if (!all.length) throw errors.conflict('平台尚未初始化');
    throw errors.badRequest('存在多个组织，请指明组织（orgSlug）');
  }

  async function login({ username, password, orgSlug = null, ip = '', ua = '' } = {}) {
    const org = resolveOrg(orgSlug);

    // 退避检查放最前：被锁的账号**连哈希都不算**，直接 429 —— 既省 CPU，也让
    // "为什么这次很快失败"可解释。锁的依据是**本账号**的历史失败，不是本次口令。
    const lock = lockStatus(org.id, username);
    if (lock.locked) {
      const secs = Math.ceil(lock.retryAfterMs / 1000);
      throw new AppError('login_throttled',
        '该账号连续登录失败次数过多，请在 ' + secs + ' 秒后重试',
        429, { retryAfterMs: lock.retryAfterMs, failCount: lock.count });
    }

    const auth = userRepo.getUserAuth(org.id, String(username || ''));

    // 统一的失败出口：不区分"无此用户"与"口令错误"；用户不存在时也跑一次哈希，
    // 让两种情况的耗时接近，避免登录接口被当成账号枚举器。
    // 失败同时计入**账号级退避**（对不存在账号也计，保持行为一致 —— 见文件上方边界）。
    const fail = () => {
      recordLoginFailure(org.id, username);
      return errors.unauthorized('账号或口令不正确');
    };
    if (!auth) {
      await hashPassword(String(password || ''), { salt: Buffer.alloc(16, 7) });
      throw fail();
    }
    const okPwd = await verifyPassword(password, auth.pwd_hash, auth.pwd_salt);
    if (!okPwd) throw fail();

    const user = userRepo.getUserById(auth.id);

    // 两步验证分支（流程与边界见下方 TOTP 小节）：口令正确、账号正常、且**已启用** TOTP 时，
    // 到此只算"第一因子通过" —— 发一张 5 分钟的一次性票据，**不发会话**。
    // 未启用 TOTP 的账号完全不经过这里，登录路径逐字不变。
    //
    // ⚠️ 位置刻意放在 clearLoginFailures **之前**：两步账号的失败计数不在此清零。
    // 若在此清零，知道口令的攻击者可循环"step1（清零）→ step2 试 4 次码"，
    // 账号永远够不到锁定阈值 —— 6 位码的在线尝试从"有上限"变成"无限"。
    // 两步账号的清零挪到第二步成功时（loginTotp）；非 TOTP 账号的清零位置不变（下一行）。
    if (user && user.status === 'active') {
      const totp = totpRepo.getTotp(user.id);
      if (totp && totp.enabled_at) return startTotpChallenge(org, user, { ip, ua });
    }

    clearLoginFailures(org.id, username);   // 口令正确即清零，避免正常用户被自己之前的误输拖累

    if (!user || user.status !== 'active') {
      throw errors.forbidden('该账号已被停用，请联系管理员');
    }

    const issued = issueSessionToken(masterSecret, { ttlMs: sessionTtlMs });
    sessionRepo.createAuthSession({
      id: issued.id,
      userId: user.id,
      tokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
      ip, ua,
    });
    userRepo.touchLogin(user.id);

    const roles = roleRepo.roleKeysForUser(user.id);
    return {
      token: issued.token,
      expiresAt: issued.expiresAt,
      sessionId: issued.id,
      user: publicUser(user, roles),
    };
  }

  /**
   * 校验令牌 → 身份。**认证路径的唯一入口**（会话令牌与 API Key 都在这里分流）。
   * @returns {{user:object, roles:string[], orgId:string, via:string, sessionId:string|null, apiKeyId:string|null, scopes:string[]}|null}
   */
  function authenticate(token) {
    if (!token) return null;

    if (String(token).startsWith(APIKEY_PREFIX)) {
      const row = apiKeyRepo.findByKeyHash(hashToken(token, masterSecret));
      if (!row || !apiKeyRepo.isUsable(row)) return null;
      const user = userRepo.getUserById(row.user_id);
      if (!user || user.status !== 'active') return null;
      apiKeyRepo.touchApiKey(row.id);
      return {
        user: publicUser(user, roleRepo.roleKeysForUser(user.id)),
        roles: roleRepo.roleKeysForUser(user.id),
        orgId: user.org_id,
        via: 'api-key',
        sessionId: null,
        apiKeyId: row.id,
        scopes: apiKeyRepo.scopesOf(row),
      };
    }

    if (!String(token).startsWith(SESSION_PREFIX)) return null;
    const row = sessionRepo.findByTokenHash(hashToken(token, masterSecret));
    if (!sessionRepo.isUsable(row)) return null;
    const user = userRepo.getUserById(row.user_id);
    if (!user || user.status !== 'active') return null;
    const roles = roleRepo.roleKeysForUser(user.id);
    return {
      user: publicUser(user, roles),
      roles,
      orgId: user.org_id,
      via: 'session',
      sessionId: row.id,
      apiKeyId: null,
      scopes: [],
    };
  }

  function logout(token) {
    if (!token || !String(token).startsWith(SESSION_PREFIX)) return { revoked: 0 };
    const row = sessionRepo.findByTokenHash(hashToken(token, masterSecret));
    if (!row) return { revoked: 0 };
    const r = sessionRepo.revoke(row.id);
    return { revoked: r && r.changes ? Number(r.changes) : 0 };
  }

  /**
   * 清理已过期/已吊销的会话记录（供 `session.purge` 定时任务调用）。
   * 只删"已失效 **且** 超过保留期"的行 —— 仍在有效期内的会话一律不动。
   * `orgId` 给定时只清本组织的（见 `authSessions.purgeStale` 的说明）。
   */
  function purgeSessions({ keepDays = 7, orgId = null } = {}) {
    const days = Number(keepDays) > 0 ? Number(keepDays) : 7;
    const r = sessionRepo.purgeStale(days, { orgId });
    // 第二步票据与它们**同频清理**：都是"已失效且超保留期"才删（条件在仓储的 SQL 里）。
    // 不在登录路径实时清的理由与 auth_sessions 相同：登录路径只读，清理由定时任务独占。
    const c = totpRepo.purgeStaleChallenges(days, { orgId });
    return {
      removed: r && r.changes ? Number(r.changes) : 0,
      challengesRemoved: c && c.changes ? Number(c.changes) : 0,
      keepDays: days, orgId: orgId || null,
    };
  }

  // ── TOTP 两步验证（2026-10 安全评审 §4.1，随 0.17.0 交付）───────────────
  //
  // 流程与边界（改动时逐条保留）：
  //   · 第一步 `login` 只证明"知道口令"；已启用 TOTP 的账号还要过 `loginTotp`
  //     （第二步）才发会话。**未启用 TOTP 的账号，登录行为与从前逐字一致**。
  //   · 第二步的跨请求状态（单次消费 / 尝试计数 / 5 分钟过期）落 `login_challenges`，
  //     票据只存 HMAC 哈希（与令牌同纪律）。两道独立的尝试上限：单张票据 5 次
  //     + 账号级指数退避（第二步失败与第一步失败计同一个计数，见 login 处的注释）。
  //   · **所有**验证"口令"或"动态码"的辅助操作失败都会记入同一账号退避 ——
  //     否则每个辅助入口都是一条无节流旁路（如"开始登记"变成口令预言机）。
  //   · 防重放：验证成功的步号经 CAS 写进 `user_totp.last_used_step`
  //     （见 repos/totp.mjs），同一窗口及更早的码不二次接受。
  //   · 登记**必须重输口令**：防"会话被窃者替受害者登记自己的验证器" ——
  //     那种状态连管理员重置口令都不会解除（它会持续把受害者锁在外面）。
  //   · 管理员重置（`resetUserTotp`）是"丢设备"的轻处置：只清第二因子与未完成票据，
  //     **不动口令、不吊销会话**；要更强处置用「重置口令」（它吊销全部会话）。
  //     重置后账号回到单步，管理员应提示用户尽快重新登记。

  /** 解 TOTP 密钥。密钥环失配/密文损坏与"码不对"同出口（不为畸形数据抛 500）。 */
  function decryptTotpSecret(secretEnc) {
    try { return decryptSecret(secretEnc, masterSecret); }
    catch { return null; }
  }

  /** 账号退避的统一闸口（与 login 第一步同一道）—— 锁定期间抛 429 */
  function assertNotLocked(orgId, username) {
    const lock = lockStatus(orgId, username);
    if (lock.locked) {
      const secs = Math.ceil(lock.retryAfterMs / 1000);
      throw new AppError('login_throttled',
        '该账号连续登录失败次数过多，请在 ' + secs + ' 秒后重试',
        429, { retryAfterMs: lock.retryAfterMs, failCount: lock.count });
    }
  }

  /** 辅助操作的"重输口令"：错误记入账号退避；成功**不清零**（否则又是清零旁路）。 */
  async function assertPasswordForUser(orgId, user, password) {
    assertNotLocked(orgId, user.username);
    const auth = userRepo.getUserAuth(orgId, user.username);
    const ok = auth ? await verifyPassword(password, auth.pwd_hash, auth.pwd_salt) : false;
    if (!ok) {
      recordLoginFailure(orgId, user.username);
      throw errors.unauthorized('口令不正确');
    }
  }

  /**
   * 第一步通过后开启第二步。**每个账号同时只有一个待验证窗口**：
   * 先作废旧的未消费票据，再签新票 —— 反复提交正确口令不会堆积出并行票据。
   */
  function startTotpChallenge(org, user, { ip = '', ua = '' } = {}) {
    const issued = issueChallengeTicket(masterSecret);
    const expiresAt = new Date(Date.now() + TOTP_CHALLENGE_TTL_MS).toISOString();
    totpRepo.invalidateOutstanding(user.id);
    totpRepo.createChallenge({
      id: issued.id, userId: user.id, orgId: org.id,
      ticketHash: issued.ticketHash, expiresAt, ip, ua,
    });
    return { twoFactorRequired: true, ticket: issued.ticket, expiresAt };
  }

  /**
   * 第二步：凭票据 + 动态码（或一次性恢复码）完成登录。
   * 任一环节失败都回**同一句**泛化错误（不给"票据不存在/过期/码错"的区别信号）。
   */
  async function loginTotp({ ticket, code, ip = '', ua = '' } = {}) {
    const failGeneric = () => errors.unauthorized('验证码不正确或已失效，请返回重新登录');
    if (!ticket || !String(ticket).startsWith(CHALLENGE_PREFIX)) throw failGeneric();

    const row = totpRepo.findChallengeByTicketHash(hashToken(String(ticket), masterSecret));
    if (!row || row.consumed_at) throw failGeneric();
    if (Date.parse(row.expires_at) <= Date.now()) throw failGeneric();

    const user = userRepo.getUserById(row.user_id);
    if (!user || user.org_id !== row.org_id || user.status !== 'active') throw failGeneric();

    // 退避闸口在"扣尝试次数"之前：锁定期间不给"票据还有次数"的豁免，也不白扣次数
    assertNotLocked(row.org_id, user.username);

    // 先扣次数再验码：码对错都消耗机会（计数无法被"验错不记"绕过，见 repos/totp.mjs）
    if (!totpRepo.useAttempt(row.id, TOTP_CHALLENGE_MAX_ATTEMPTS)) throw failGeneric();

    const totp = totpRepo.getTotp(user.id);
    let step = null;
    if (totp && totp.enabled_at) {
      const secret = decryptTotpSecret(totp.secret_enc);
      if (secret) {
        const v = verifyTotp(secret, String(code == null ? '' : code).trim(), { lastUsedStep: totp.last_used_step });
        // 防重放 CAS：步号写不回（并发用了同一码）→ 视为失败
        if (v.ok && totpRepo.advanceTotpStep(user.id, v.step)) step = v.step;
      }
    }

    let viaRecoveryCode = false;
    if (step == null) {
      // 动态码不成立 → 再试恢复码（一次性）。恢复码只用于完成登录，不能自我续命。
      const rec = totpRepo.findUnusedRecoveryByHash(user.id, recoveryCodeHash(code, masterSecret));
      if (rec && totpRepo.markRecoveryUsed(rec.id)) viaRecoveryCode = true;
    }

    if (step == null && !viaRecoveryCode) {
      recordLoginFailure(row.org_id, user.username);
      throw failGeneric();
    }

    totpRepo.consumeChallenge(row.id);
    clearLoginFailures(row.org_id, user.username);   // 第二步成功才清零（两步账号）

    const issued = issueSessionToken(masterSecret, { ttlMs: sessionTtlMs });
    sessionRepo.createAuthSession({
      id: issued.id, userId: user.id, tokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt, ip, ua,
    });
    userRepo.touchLogin(user.id);

    const roles = roleRepo.roleKeysForUser(user.id);
    return {
      token: issued.token,
      expiresAt: issued.expiresAt,
      sessionId: issued.id,
      user: publicUser(user, roles),
      viaRecoveryCode,
      // 恢复码登录时把剩余数带回给调用方（界面可提示"该重新生成一批了"）
      recoveryCodesLeft: viaRecoveryCode ? totpRepo.countUnusedRecoveryCodes(user.id) : null,
    };
  }

  /** 我的两步验证状态。**不含密钥** —— 密钥只在登记响应里出现那一次。 */
  function totpStatus(userId) {
    const u = userRepo.getUserById(userId);
    if (!u) throw errors.notFound('用户不存在');
    const row = totpRepo.getTotp(u.id);
    const enabled = !!(row && row.enabled_at);
    return {
      enabled,
      pending: !!(row && !row.enabled_at),
      enabledAt: enabled ? row.enabled_at : null,
      recoveryCodesLeft: enabled ? totpRepo.countUnusedRecoveryCodes(u.id) : 0,
    };
  }

  /**
   * 开始登记：生成新密钥（加密落库、未启用），返回 otpauth URI 给验证器 App。
   * 要求重输口令（见小节头注释）；已启用时拒绝 —— "重新开始登记"绝不静默换掉生效中的密钥。
   */
  async function totpBeginEnroll(orgId, userId, { password } = {}) {
    const user = userRepo.getUser(orgId, userId);
    if (!user) throw errors.notFound('用户不存在');
    await assertPasswordForUser(orgId, user, password);
    const existing = totpRepo.getTotp(user.id);
    if (existing && existing.enabled_at) {
      throw errors.conflict('两步验证已启用。要更换验证器请先停用；丢了设备请让管理员重置。');
    }
    const secret = generateSecret();
    const stored = totpRepo.upsertPendingTotp(user.id, encryptSecret(secret, masterSecret));
    if (!stored) throw errors.conflict('两步验证已启用，登记请求被拒绝');
    return {
      secret,
      otpauthUri: otpauthUri({ secret, label: user.username }),
      digits: TOTP_DIGITS,
      periodSec: TOTP_PERIOD_SEC,
      note: '用验证器 App 扫码或手动录入密钥，再输入 App 显示的 6 位动态码完成确认。'
        + '密钥在确认前不生效；离开本页后不会再显示。',
    };
  }

  /** 确认登记：验证一个动态码 → 置为已启用 + 生成一批恢复码（明文只出现这一次）。 */
  async function totpConfirmEnroll(orgId, userId, { code } = {}) {
    const user = userRepo.getUser(orgId, userId);
    if (!user) throw errors.notFound('用户不存在');
    assertNotLocked(orgId, user.username);
    const row = totpRepo.getTotp(user.id);
    if (!row || row.enabled_at) {
      throw errors.conflict(row ? '两步验证已启用' : '尚未开始登记，请先生成密钥');
    }
    const secret = decryptTotpSecret(row.secret_enc);
    const v = secret ? verifyTotp(secret, code) : { ok: false };
    if (!v.ok) {
      recordLoginFailure(orgId, user.username);   // 6 位码的在线尝试同样要节流
      throw errors.badRequest('验证码不正确，请核对验证器 App 的当前显示值');
    }
    if (!totpRepo.enableTotp(user.id, { step: v.step })) throw errors.conflict('登记状态已变化，请重新开始');
    const codes = generateRecoveryCodes();
    totpRepo.replaceRecoveryCodes(user.id, codes.map((c) => recoveryCodeHash(c, masterSecret)));
    return {
      enabled: true,
      recoveryCodes: codes,
      note: '恢复码只显示这一次，请抄写/打印保存（每张只能用一次）。',
    };
  }

  /**
   * 停用两步验证。要**口令 + 当前动态码**双证 —— 停用是安全降级，强度须与启用对等：
   * 仅有会话（无口令）或仅有口令（无第二因子）都不够。
   */
  async function totpDisable(orgId, userId, { password, code } = {}) {
    const user = userRepo.getUser(orgId, userId);
    if (!user) throw errors.notFound('用户不存在');
    const row = totpRepo.getTotp(user.id);
    if (!row || !row.enabled_at) throw errors.conflict('两步验证尚未启用');
    await assertPasswordForUser(orgId, user, password);
    const secret = decryptTotpSecret(row.secret_enc);
    const v = secret ? verifyTotp(secret, code, { lastUsedStep: row.last_used_step }) : { ok: false };
    if (!v.ok) {
      recordLoginFailure(orgId, user.username);
      throw errors.badRequest('验证码不正确');
    }
    totpRepo.advanceTotpStep(user.id, v.step);      // 刚用过的码不能再拿去登录
    totpRepo.deleteTotp(user.id);
    totpRepo.deleteRecoveryCodesForUser(user.id);   // 停用即回到单步账号的完整状态
    totpRepo.invalidateOutstanding(user.id);        // 已发未验的第二步窗口一并作废
    return { enabled: false };
  }

  /**
   * 重新生成恢复码（旧的整批作废）。**只认动态码** —— 恢复码不能换出新的恢复码，
   * 否则"偷到一张"就能自我续命；动态码用掉后步号推进，不能接着去登录。
   */
  function totpRegenerateRecoveryCodes(orgId, userId, { code } = {}) {
    const user = userRepo.getUser(orgId, userId);
    if (!user) throw errors.notFound('用户不存在');
    assertNotLocked(orgId, user.username);
    const row = totpRepo.getTotp(user.id);
    if (!row || !row.enabled_at) throw errors.conflict('两步验证尚未启用');
    const secret = decryptTotpSecret(row.secret_enc);
    const v = secret ? verifyTotp(secret, code, { lastUsedStep: row.last_used_step }) : { ok: false };
    if (!v.ok) {
      recordLoginFailure(orgId, user.username);
      throw errors.badRequest('验证码不正确');
    }
    totpRepo.advanceTotpStep(user.id, v.step);
    const codes = generateRecoveryCodes();
    totpRepo.replaceRecoveryCodes(user.id, codes.map((c) => recoveryCodeHash(c, masterSecret)));
    return { recoveryCodes: codes, note: '新的恢复码已生成，旧的**全部作废**。只显示这一次。' };
  }

  /**
   * 管理员重置某用户的 TOTP（安全评审 §4.1："管理员可重置，重置不动口令"）。
   * 只清第二因子与其未完成票据；**不动口令、不吊销会话** —— 这是"丢了设备"的轻处置
   * （更强的处置是「重置口令」，那条路吊销全部会话）。重置后该账号回到单步登录，
   * 管理员应提示用户尽快重新登记；操作记审计（identity.user.totp-reset）。
   */
  function resetUserTotp(orgId, userId) {
    const user = userRepo.getUser(orgId, userId);
    if (!user) throw errors.notFound('用户不存在');
    const had = totpRepo.deleteTotp(user.id);
    const codesRemoved = totpRepo.deleteRecoveryCodesForUser(user.id);
    const challengesInvalidated = totpRepo.invalidateOutstanding(user.id);
    return { ok: true, id: user.id, username: user.username, hadTotp: had > 0, codesRemoved, challengesInvalidated };
  }

  /**
   * "算不算管理员"的**唯一判据**：生效角色里有没有 owner/admin。
   *
   * 为什么是它而不是别的：组让"谁是管理员"变成间接的（用户 ← 组 ← 角色）。
   * 真源只有 `role_bindings` 一处 —— 0001 起还有一个 `users.is_admin` 物化列，
   * 已由迁移 0015 **删除**（它被维护着却从不被判定读取，是清单里最典型的"冗余真相"）。
   * 展示层要用这个判据，也必须**当场从角色算**，不要再引入第二份可能漂移的说法。
   */
  function isAdminBy(roles) {
    return (roles || []).some((r) => r === 'owner' || r === 'admin');
  }

  function publicUser(user, roles, groups) {
    if (!user) return null;
    const effRoles = Array.isArray(roles) ? roles : roleRepo.roleKeysForUser(user.id);
    const gs = Array.isArray(groups) ? groups : groupRepo.groupsForUser(user.org_id, user.id);
    return {
      id: user.id,
      orgId: user.org_id,
      deptId: user.dept_id || null,
      username: user.username,
      displayName: user.display_name,
      status: user.status,
      isAdmin: isAdminBy(effRoles),
      roles: effRoles,
      /** 所属组（角色可能来自组，这里要能看清"从哪来的"） */
      groups: gs,
      lastLoginAt: user.last_login_at || null,
      createdAt: user.created_at,
    };
  }

  /** 把物化列刷成与生效角色一致。**已随迁移 0015 删除**（is_admin 列不再存在）。
   *
   *  历史：M1 起每次改绑定都会写一下 `users.is_admin`，但没有任何判定读它 ——
   *  一次全量体检把这条"维护着却从不被用"的冗余真相列了出来，处置是彻底删除。
   *  这里保留一个空的说明位（而不是整个函数消失得无影无踪）是为了让后来者
   *  在 git 历史里能搜到"它曾经存在、为什么被删"。 */

  /**
   * owner 保护的统一出口：**变更发生之后再数一遍**，从"有"变成"没有"就抛错让事务回滚。
   *
   * 为什么不是事前预判：组让这件事成了多对多（用户 ← 组 ← 角色）。
   * 事前推演要枚举"这次改动会牵连到哪些用户"，漏一条路径就等于没有保护。
   * 事后计数只有一种写法，且天然覆盖所有路径。
   *
   * 为什么要求 `before > 0`：如果组织**本来就**没有生效的 owner
   * （例如唯一那张 owner 单挂在一个空组上），删掉这个空组并不会让情况变坏，
   * 这时候拒绝删除只是无意义的刁难 —— 保护的是"从有到无"这个**转变**。
   */
  function withOwnerGuard(orgId, what, fn) {
    const before = roleRepo.countHolders(orgId, 'owner');
    return tx(() => {
      const r = fn();
      if (before > 0 && roleRepo.countHolders(orgId, 'owner') === 0) {
        throw errors.conflict('该操作（' + what + '）会让组织一个生效的所有者都不剩 —— 已整体回滚。'
          + '请先把某个用户或组设为 owner，再执行本操作。');
      }
      return r;
    });
  }

  // ── 账号管理 ─────────────────────────────────────────────────────────

  async function createUser({ orgId, username, password, displayName, deptId = null, roleKeys = ['member'] }) {
    const uname = String(username || '').trim();
    if (!/^[A-Za-z0-9._@-]{2,64}$/.test(uname)) {
      throw errors.badRequest('账号需为 2–64 位的字母、数字或 . _ - @ 组合');
    }
    if (userRepo.getUserByUsername(orgId, uname)) {
      throw errors.conflict('该账号在本组织内已存在：' + uname);
    }
    const strength = checkPasswordStrength(password);
    if (!strength.ok) throw errors.badRequest('口令不符合要求：' + strength.reason);
    for (const rk of roleKeys) {
      if (!knownRole(rk)) throw errors.badRequest('未知角色：' + rk);
    }
    // 部门归属的跨租户守卫（与 `setUserProfile` 同一道）。
    // 原先 `deptId` 是**原样写库**的 —— 传一个别家的部门 id 也能落进去，
    // 而且不报错、不生效，属于"看起来没事的错"。写入端拦掉。
    const dept = deptId ? assertDeptOfOrg(orgId, deptId) : null;

    const pwd = await hashPassword(password);

    const user = tx(() => {
      const u = userRepo.createUser({
        orgId, username: uname, displayName: String(displayName || uname),
        deptId: dept, pwdHash: pwd.hash, pwdSalt: pwd.salt,
      });
      for (const rk of roleKeys) {
        const role = roleRepo.getRoleByKey(orgId, rk);
        if (!role) throw errors.internal('内置角色缺失：' + rk + '（组织数据可能不完整）');
        roleRepo.bindRole({ subjectType: 'user', subjectId: u.id, roleId: role.id, scopeType: 'tenant' });
      }
      return u;
    });
    return publicUser(user, roleKeys);
  }

  /**
   * CSV 批量导入账号（管理员动作）。
   *
   * 语义锁定为**逐行独立**：一行失败只跳过该行，其余照常创建 —— 并如实报回
   * 每行的物理行号与原因。重跑是安全的：已创建的行会按「账号已存在」逐行拒绝，
   * 不会重复创建、也不会重复报成功。
   *
   * ⚠️ 三个不能动的细节：
   *   1. 行数上限检查在**任何** createUser / 哈希之前 —— 见 IMPORT_MAX_ROWS 注释；
   *   2. 口令**不做 trim**（parseCsvRecords 原样保留空白）—— 用户设的 " abc "
   *      就是那个口令，偷偷裁掉等于替他把口令改错；
   *   3. 部门按**名称**解析成 id（CSV 里没人去抄 32 位 id）—— 写库前换成本组织
   *      的部门 id，跨租户从"名称对不上"这一层就不可能发生。
   */
  async function importUsers(orgId, { csv } = {}) {
    const records = parseCsvRecords(csv).filter((r) => r.cells.some((c) => c !== ''));
    if (!records.length) {
      throw errors.badRequest('CSV 里没有内容（第一行应为表头：账号,口令,姓名,部门,角色）');
    }

    // ── 表头：大小写不敏感、中英文别名；未知列 / 重复列 / 缺必需列一律拒绝 ──
    const header = records[0].cells.map((c) => String(c).trim().toLowerCase());
    const idx = {};
    const seen = {};
    const label = { username: '账号', password: '口令', displayName: '姓名', dept: '部门', roles: '角色' };
    for (let i = 0; i < header.length; i++) {
      const h = header[i];
      if (!h) throw errors.badRequest('表头第 ' + (i + 1) + ' 列是空的 —— 请检查列数与分隔符是否一致');
      const field = Object.keys(IMPORT_COLUMNS).find((k) => IMPORT_COLUMNS[k].includes(h));
      if (!field) throw errors.badRequest('无法识别的列「' + records[0].cells[i] + '」（可用列：账号、口令、姓名、部门、角色）');
      if (seen[field]) throw errors.badRequest('列重复：「' + label[field] + '」列出现了两次（' + seen[field] + ' / ' + records[0].cells[i] + '）');
      seen[field] = String(records[0].cells[i]);
      idx[field] = i;
    }
    if (idx.username === undefined) throw errors.badRequest('表头缺少「账号」列');
    if (idx.password === undefined) throw errors.badRequest('表头缺少「口令」列');

    const dataRows = records.slice(1);
    if (!dataRows.length) throw errors.badRequest('CSV 只有表头、没有数据行');

    // ⚠️ 上限在任何哈希之前 —— 这是"拒绝大文件"的唯一一道闸（见 IMPORT_MAX_ROWS）
    if (dataRows.length > IMPORT_MAX_ROWS) {
      throw errors.badRequest('单次最多导入 ' + IMPORT_MAX_ROWS + ' 行（本次 ' + dataRows.length + ' 行）。'
        + '口令哈希是刻意做慢的，一次导入过多会让请求超时；请拆分后分批导入'
        + '（已创建的账号在重试时会按「账号已存在」逐行拒绝，不会重复创建）。');
    }

    // ── 部门名 → id；同名歧义标为 null，逐行报错（唯一性只在组织内轻量校验，schema 没设唯一键）──
    const deptByName = new Map();
    for (const d of orgRepo.listDepartments(orgId)) {
      const k = String(d.name).trim();
      deptByName.set(k, deptByName.has(k) ? null : d.id);
    }

    const out = [];
    let created = 0;
    for (const rec of dataRows) {
      const cellAt = (k) => (idx[k] === undefined ? '' : String(rec.cells[idx[k]] == null ? '' : rec.cells[idx[k]]));
      const uname = cellAt('username').trim();
      const password = cellAt('password');   // ⚠️ 不 trim —— 口令里的空格是口令的一部分
      const displayName = cellAt('displayName').trim();
      const deptName = cellAt('dept').trim();
      const roleKeys = [...new Set(cellAt('roles').split(/[,;|]/).map((x) => x.trim()).filter(Boolean))];

      // 先在行内把"能说清楚"的错挑出来，再交给 createUser 走完整校验（口令强度、重名等）。
      // 这样报表里的原因才是给 Excel 用户看的，而不是一串内部错误码。
      let fail = null;
      let deptId = null;
      if (!uname) fail = '账号为空';
      else if (!password) fail = '口令为空';
      else if (displayName.length > 128) fail = '姓名超过 128 字';
      else if (deptName) {
        if (!deptByName.has(deptName)) fail = '部门不存在：' + deptName;
        else if (deptByName.get(deptName) === null) fail = '部门名不唯一：' + deptName;
        else deptId = deptByName.get(deptName);
      }

      if (fail) {
        out.push({ line: rec.line, username: uname, ok: false, error: fail });
        continue;
      }
      try {
        const u = await createUser({
          orgId, username: uname, password, displayName, deptId,
          roleKeys: roleKeys.length ? roleKeys : ['member'],
        });
        created++;
        out.push({ line: rec.line, username: uname, ok: true, id: u.id });
      } catch (e) {
        out.push({ line: rec.line, username: uname || '(空)', ok: false, error: e && e.message ? String(e.message) : '未知错误' });
      }
    }
    return { total: dataRows.length, created, failed: dataRows.length - created, rows: out };
  }

  /**
   * 用户列表。**批量取角色、组与 TOTP 状态**，不是每人查三次 ——
   * 100 个用户时那是 300 次往返，而列表页每次渲染都会调一遍。
   */
  function listUsers(orgId, opts) {
    const rows = userRepo.listUsers(orgId, opts);
    const ids = rows.map((u) => u.id);
    const rolesMap = roleRepo.roleKeysForUsers(ids);
    const groupsMap = groupRepo.groupsForUsers(orgId, ids);
    const totpEnabled = totpRepo.enabledUserIds(ids);
    return rows.map((u) => Object.assign(publicUser(u, rolesMap.get(u.id) || [], groupsMap.get(u.id) || []), {
      /** 是否已启用两步验证 —— 列表页要给管理员一个"谁还裸奔"的视角（管理动作见 resetUserTotp） */
      totpEnabled: totpEnabled.has(u.id),
    }));
  }

  /**
   * 改**直接**角色绑定（整组替换）。
   * 只动 `subject_type='user'` 的绑定 —— 组带来的角色不在这里被覆盖（那属于组的事）。
   * 保护规则：不允许把组织里最后一个 owner 降权 —— 否则组织会变成没人能管。
   *   （"最后一个"按**生效**算：直接持有的 + 凭组持有的。）
   */
  function setUserRoles(orgId, userId, roleKeys) {
    const target = userRepo.getUser(orgId, userId);
    if (!target) throw errors.notFound('用户不存在');
    const keys = [...new Set(roleKeys.map(String))];
    for (const rk of keys) if (!knownRole(rk)) throw errors.badRequest('未知角色：' + rk);

    return withOwnerGuard(orgId, '调整用户角色', () => {
      for (const b of roleRepo.bindingsForSubject('user', userId)) roleRepo.unbindRole(b.id);
      for (const rk of keys) {
        const role = roleRepo.getRoleByKey(orgId, rk);
        if (!role) throw errors.internal('内置角色缺失：' + rk);
        roleRepo.bindRole({ subjectType: 'user', subjectId: userId, roleId: role.id, scopeType: 'tenant' });
      }
      return publicUser(userRepo.getUser(orgId, userId));
    });
  }

  // ── 范围级授权（4.6 库级 ACL 的写入端）───────────────────────────────
  //
  // 语义：把某主体（用户/组）在**某一个范围**（当前开放：知识库、工作区）上授权为某角色。
  // 载体复用 `role_bindings` 的既有字段（`scope_type` / `scope_id`），零新表。
  //
  // 为什么权限档位复用**内置角色**而不是自定义枚举：库级"能读到什么程度"与
  // 组织级本来就是同一套语义（只读/读写/管理），用角色 key 表达就自动与
  // `permissions.mjs` 的能力矩阵同源 —— 不需要维护第二张权限表，也不会出现
  // "库里写 viewer 但判定表里没有 viewer"这类漂移。判定见 knowledge/visibility.mjs。
  //
  // ⚠️ 范围类型是**白名单**：开放新范围（如 department）要显式加进来，
  // 而不是"传什么就写什么"——否则任何字符串都能变成一个新的授权维度。

  const SCOPED_TYPES = new Set(['knowledge_base', 'workspace']);

  function assertScopeType(scopeType) {
    const st = String(scopeType || '');
    if (!SCOPED_TYPES.has(st)) {
      throw errors.badRequest('不支持的范围类型：' + st + '（当前支持：' + [...SCOPED_TYPES].join(', ') + '）');
    }
    return st;
  }

  /** 某用户在指定范围类型上生效的库级角色（含组带来的），逐 scope 展开 */
  function scopedRolesForUser(userId, scopeType) {
    return roleRepo.scopedRolesForUser(userId, assertScopeType(scopeType));
  }

  /** 某范围上的全部授权（含主体名），供"这个库授权给了谁"页 */
  function listScopeBindings(orgId, scopeType, scopeId) {
    return roleRepo.bindingsForScope(orgId, assertScopeType(scopeType), scopeId);
  }

  /**
   * 主体必须**存在且属于本组织**。
   *
   * 仓储层（`bindRole`）其实会校验这两件事，但它抛的是**裸 Error** —— 出去会被
   * `toHttpError` 收敛成 `500 internal_error`，于是"这个账号已经被删了"在调用方看到的是
   * "服务器坏了"。授权入口现在有界面了（体检 §B9），下拉里的 id 在
   * "页面加载之后那个人被删掉"这种竞态下会陈旧，这条路是**真实可达**的，
   * 必须给出可理解的状态码。这是"仓储抛裸 Error、服务层翻译成带 HTTP 语义的错误"
   * 那条分层纪律的具体落地（见 util/errors.mjs 顶部）。
   *
   * 「存在于别的组织」按**不存在**处理（404）：不向调用方确认"这个 id 存在，只是不属于你"，
   * 与 `revokeScopedRole` 同一条纪律 —— 否则这里会变成一个跨租户的 id 探测器。
   */
  function assertSubjectOfOrg(orgId, subjectType, subjectId) {
    const sid = String(subjectId || '').trim();
    if (!sid) throw errors.badRequest('缺少主体 id（subjectId）');
    const row = subjectType === 'group' ? groupRepo.getGroup(orgId, sid) : userRepo.getUser(orgId, sid);
    if (!row) throw errors.notFound((subjectType === 'group' ? '用户组' : '用户') + '不存在：' + sid);
    return row;
  }

  /**
   * 授权：`orgId` 是操作者所属组织，同时用作"角色必须属于本组织"的锚。
   * `bindRole` 内部还会校验**主体与角色同组织**（跨组织绑定直接抛错），
   * 所以这里不需要重复那层；本函数补的是"范围 id 非空 / 角色 key 已知 / **主体存在**"三道 ——
   * 最后一道在前端已有入口后不再是理论问题（见 `assertSubjectOfOrg`）。
   */
  function grantScopedRole({ orgId, scopeType, scopeId, subjectType = 'user', subjectId, roleKey }) {
    const st = assertScopeType(scopeType);
    const sid = String(scopeId || '').trim();
    if (!sid) throw errors.badRequest('缺少范围 id（scopeId）');
    const rk = String(roleKey || '').trim();
    if (!knownRole(rk)) throw errors.badRequest('未知角色：' + rk);
    // 只认这两种主体：写成别的值不该靠仓储层兜（那里也是抛裸 Error）。
    const subjType = subjectType === 'group' ? 'group' : 'user';
    const subject = assertSubjectOfOrg(orgId, subjType, subjectId);
    const role = roleRepo.getRoleByKey(orgId, rk);
    if (!role) throw errors.internal('内置角色缺失：' + rk);
    return roleRepo.bindRole({
      subjectType: subjType, subjectId: subject.id, roleId: role.id, scopeType: st, scopeId: sid,
    });
  }

  /**
   * 撤销范围级授权。
   * 归属校验：先经 `role_id` 反查该绑定所属组织，与操作者组织不一致时按
   * **不存在**处理（notFound，而非 forbidden）—— 不向调用者确认"这个 id 存在，
   * 只是不属于你"，避免把别的组织的绑定 id 变成一个可探测的信号。
   * `bindRole` 的幂等配对在这里也成立：撤不存在的绑定会 404，而不是静默成功。
   */
  function revokeScopedRole(orgId, bindingId) {
    const owner = roleRepo.orgIdOfBinding(bindingId);
    if (owner == null || String(owner) !== String(orgId)) {
      throw errors.notFound('授权不存在：' + bindingId);
    }
    roleRepo.unbindRole(bindingId);
    return { ok: true, id: bindingId };
  }

  function setUserStatus(orgId, userId, status) {
    if (!['active', 'disabled'].includes(status)) throw errors.badRequest('状态只能是 active 或 disabled');
    const target = userRepo.getUser(orgId, userId);
    if (!target) throw errors.notFound('用户不存在');
    if (status === 'disabled') {
      // 停用**不改绑定**，所以"数绑定"的保护看不出问题 —— 必须按"还能不能登录"算。
      // 生效角色（含组带来的）里有 owner 且他是最后一个在用的 owner → 拒绝。
      const eff = roleRepo.roleKeysForUser(userId);
      if (eff.includes('owner') && roleRepo.countActiveHolders(orgId, 'owner') <= 1) {
        throw errors.conflict('不能停用组织最后一个生效的所有者 —— 停用后没有人能管理该组织');
      }
      sessionRepo.revokeAllForUser(userId);   // 停用即踢下线
    }
    return publicUser(userRepo.updateUser(orgId, userId, { status }));
  }

  async function resetPassword(orgId, userId, newPassword) {
    const target = userRepo.getUser(orgId, userId);
    if (!target) throw errors.notFound('用户不存在');
    const strength = checkPasswordStrength(newPassword);
    if (!strength.ok) throw errors.badRequest('口令不符合要求：' + strength.reason);
    const pwd = await hashPassword(newPassword);
    userRepo.setUserPassword(userId, pwd.hash, pwd.salt);
    sessionRepo.revokeAllForUser(userId);      // 改密后旧会话立即失效
    return { ok: true, sessionsRevoked: true };
  }

  /**
   * 删除用户 —— **真删**，与"停用"（`setUserStatus`）是两件事。
   *
   * 为什么两条路径都要留：停用**可逆**、保留全部绑定与历史，适合"休假 / 观察期"；
   * 删除**不可逆**，适合"这个人确实不该再在册"。把删除也做成软删，会让
   * "他还在不在册"变成一句要靠字段解释的模糊话 —— 而 `users` 行存在与否，
   * 本身就该是一个**明确的事实**。
   *
   * 四道守卫（缺一条都会出事）：
   *   1. **不能删当前登录的账号** —— 一次误点就把自己踢出去，且再没法登录改回来；
   *   2. **不能把组织删到一个 owner 都不剩** —— 交给 `withOwnerGuard`，命中即整体回滚
   *      （它数的是**生效** owner，含组带进来的，因此"删掉最后一个 owner 组里唯一的成员"也会被拦）；
   *   3. **只能删本组织的人** —— `orgId` 参与 WHERE，别家 id 取不到 → 404
   *      （而不是"删掉了一个别家用户"这种跨租户事故）；
   *   4. **依赖行必须先清** —— `auth_sessions` / `api_keys` / `group_members` 以及
   *      两步验证三表（`user_totp` / `user_recovery_codes` / `login_challenges`）都带
   *      `REFERENCES users(id)` 且外键默认 RESTRICT，不清就直接抛一句调用方看不懂的约束错误。
   *
   * 刻意**不动**审计日志：它记的是"当时发生了什么"。用户被删后，审计里那个 id
   * 指向一个已不在册的人 —— 这是对的，历史不该被回溯改写。
   *
   * @returns {{ok:true, id:string, username:string, removed:{roleBindings:number, groupMemberships:number, apiKeys:number, sessions:number, totp:number, recoveryCodes:number, loginChallenges:number}}}
   */
  function deleteUser(orgId, id, { actorUserId = null } = {}) {
    const uid = String(id);
    const user = userRepo.getUser(orgId, uid);
    if (!user) throw errors.notFound('用户不存在');
    if (actorUserId != null && String(actorUserId) === uid) {
      throw errors.conflict('不能删除当前登录的账号 —— 会把自己锁在外面。要收回权限请改用「停用」或调整角色。');
    }

    const removed = { roleBindings: 0, groupMemberships: 0, apiKeys: 0, sessions: 0, totp: 0, recoveryCodes: 0, loginChallenges: 0 };
    withOwnerGuard(orgId, '删除用户「' + user.username + '」', () => {
      // 顺序固定：先清引用方（外键 RESTRICT），再删本人
      for (const b of roleRepo.bindingsForSubject('user', uid)) {
        roleRepo.unbindRole(b.id);
        removed.roleBindings++;
      }
      removed.groupMemberships = groupRepo.removeMembershipsForUser(uid);
      removed.apiKeys = apiKeyRepo.deleteForUser(uid);
      removed.sessions = sessionRepo.deleteForUser(uid);
      removed.totp = totpRepo.deleteTotp(uid);
      removed.recoveryCodes = totpRepo.deleteRecoveryCodesForUser(uid);
      removed.loginChallenges = totpRepo.deleteChallengesForUser(uid);
      userRepo.deleteUser(orgId, uid);
    });

    return { ok: true, id: uid, username: user.username, removed };
  }

  // ── 角色 ─────────────────────────────────────────────────────────────

  function listRoles(orgId) {
    return roleRepo.listRoles(orgId);
  }

  // ── 用户组 ───────────────────────────────────────────────────────────
  //
  // 组是**角色绑定的第二种主体**。没有它的时候，`role_bindings.subject_type='group'`
  // 是一个"承认了却做不到"的枚举值：绑定会被写进库，却永远不影响判定。

  /** 组详情（含角色与成员）。组通常是个位数，逐个查角色可以接受；上千组要改批量。 */
  function describeGroup(orgId, id) {
    const g = groupRepo.getGroup(orgId, id);
    if (!g) throw errors.notFound('组不存在');
    return {
      id: g.id, name: g.name, description: g.description, createdAt: g.created_at,
      roles: groupRepo.roleKeysOfGroup(orgId, id),
      members: groupRepo.membersOf(orgId, id).map((m) => ({
        userId: m.user_id, username: m.username, displayName: m.display_name, status: m.status,
      })),
    };
  }

  function listGroups(orgId) {
    const groups = groupRepo.listGroups(orgId);
    const out = [];
    for (const g of groups) {
      out.push({
        id: g.id, name: g.name, description: g.description,
        memberCount: Number(g.member_count || 0),
        roles: groupRepo.roleKeysOfGroup(orgId, g.id),
        createdAt: g.created_at,
      });
    }
    return out;
  }

  function createGroup(orgId, { name, description = '' }) {
    const n = String(name || '').trim();
    if (!n) throw errors.badRequest('组名不能为空');
    if (n.length > 64) throw errors.badRequest('组名不能超过 64 个字符');
    if (groupRepo.getGroupByName(orgId, n)) throw errors.conflict('同名组已存在：' + n);
    return describeGroup(orgId, groupRepo.createGroup({ orgId, name: n, description }).id);
  }

  function updateGroup(orgId, id, patch = {}) {
    if (!groupRepo.getGroup(orgId, id)) throw errors.notFound('组不存在');
    const patchIn = {};
    if (patch.name !== undefined) {
      const n = String(patch.name || '').trim();
      if (!n) throw errors.badRequest('组名不能为空');
      const dup = groupRepo.getGroupByName(orgId, n);
      if (dup && dup.id !== String(id)) throw errors.conflict('同名组已存在：' + n);
      patchIn.name = n;
    }
    if (patch.description !== undefined) patchIn.description = patch.description == null ? '' : String(patch.description);
    groupRepo.updateGroup(orgId, id, patchIn);
    return describeGroup(orgId, id);
  }

  function deleteGroup(orgId, id) {
    const g = groupRepo.getGroup(orgId, id);
    if (!g) throw errors.notFound('组不存在');
    const members = groupRepo.memberIdsOf(orgId, id);
    withOwnerGuard(orgId, '删除组「' + g.name + '」', () => {
      // 先撤绑定再删组：留下指向已删组的绑定，将来一旦有同 id 的行（导入 / 恢复 / 手写 SQL）
      // 就会"借尸还魂"把权限带回来 —— 脏数据不该有复活的能力。
      for (const b of roleRepo.bindingsForSubject('group', id)) roleRepo.unbindRole(b.id);
      groupRepo.deleteGroup(orgId, id);
    });
    return { ok: true, id, removedMembers: members.length };
  }

  // ── 部门（组织架构）──────────────────────────────────────────────────
  //
  // ⚠️ **部门不是权限载体**。它与「用户组」是两件不同的事，别混：
  //   · 用户组（groups）**承载角色绑定** —— 组上的角色对成员生效（见 setGroupRoles）；
  //   · 部门（departments）**只表示组织归属** —— 挂在哪个部门**不改变任何权限判定**
  //     （判定只看 role_bindings，见 permissions.mjs / knowledge/visibility.mjs）。
  // 为什么仍然要有部门：本项目目标场景是「部门级内网」，而"这个单位有哪些人"是一个
  // 真实的组织视图需求，`users.dept_id` 就是它的唯一职责。把这条说清楚，就不会有人
  // 以为"把人挪进某部门"会顺带给他什么权限。
  //
  // 边界（如实，不假装）：
  //   · 支持**创建 / 列出 / 改名 / 删除 / 调整用户归属**；
  //   · 改名与删除都是**带引用护栏**的（见 renameDepartment / deleteDepartment）：
  //     有成员的部门、有子部门的部门都**拒绝删除并给出人话理由**，而不是让用户拿到
  //     一句 SQLite 的 FOREIGN KEY 约束错误 —— FK 是 ON 的（db.mjs），
  //     裸 DELETE 被引用的部门会抛约束错误；护栏在服务层先把"为什么不行、下一步做什么"
  //     讲清楚。`parent_id` 是弱引用、同样按此处理；
  //   · `parent_id` 列存在且**创建时可写**，但**不提供层级接口**（列表按创建顺序平铺返回，
  //     每行带 `parentId` 与 `childCount`）—— 前端也不渲染树。属预留，不影响"能不能用"。

  const DEPT_NAME_MAX = 64;

  /**
   * 部门归属的**跨租户守卫**：`deptId` 必须属于本组织。
   *
   * 为什么必须有：`users.dept_id` 是指向 `departments(id)` 的弱引用，**任何组织的部门 id
   * 在语法上都合法**。不校验的话，调用方传别家的部门 id 也能写进去 —— 那是一个跨租户引用，
   * 而且它不会报错、只是永远对不上（读的时候没人做拼接，所以表面看"没事"）。
   * 这类"看起来没事的错"正是最该在写入端拦掉的。
   *
   * @returns {string|null} 规范化后的部门 id（空值统一为 null = 不归属任何部门）
   */
  function assertDeptOfOrg(orgId, deptId) {
    const id = String(deptId == null ? '' : deptId).trim();
    if (!id) return null;
    const d = orgRepo.getDepartment(orgId, id);
    if (!d) throw errors.badRequest('部门不存在或不属于本组织：' + id);
    return d.id;
  }

  function publicDepartment(d, memberCount = null, childCount = null) {
    if (!d) return null;
    return {
      id: d.id,
      orgId: d.org_id,
      name: d.name,
      parentId: d.parent_id || null,
      memberCount,
      childCount,
      createdAt: d.created_at,
    };
  }

  function createDepartment(orgId, { name, parentId = null } = {}) {
    const nm = String(name || '').trim();
    if (!nm) throw errors.badRequest('部门名称不能为空');
    if (nm.length > DEPT_NAME_MAX) throw errors.badRequest('部门名称过长（最多 ' + DEPT_NAME_MAX + ' 字）');
    // schema 未设唯一键（同级内重名），所以在服务层做一次轻量校验。
    // 这是**尽力而为**而非强约束：并发创建同名仍可能同时通过 —— 但部门是低频动作，
    // 为它加一张唯一索引的迁移不划算，如实记在这里。
    if (orgRepo.findDepartmentByName(orgId, nm)) {
      throw errors.conflict('本组织已有同名部门：' + nm);
    }
    const parent = assertDeptOfOrg(orgId, parentId);
    // 返回**与列表同形状**：新建时成员数与子部门数必定是 0，但它们必须是数字而不是 null。
    // 不然同一个资源在"创建"与"列表"两个接口里字段类型不同 —— 前端 `d.memberCount + ' 人'`
    // 在创建路径上会渲染出 "null 人" 这种只有仔细看才发现的东西。
    return publicDepartment(orgRepo.createDepartment({ orgId, name: nm, parentId: parent }), 0, 0);
  }

  /** 部门列表，带成员数与子部门数（前端要显示"这个部门有几个人"、删之前要看得见引用）。 */
  function listDepartments(orgId) {
    const counts = userRepo.countUsersByDept(orgId);
    const childCounts = orgRepo.countDepartmentsByParent(orgId);
    return orgRepo.listDepartments(orgId)
      .map((d) => publicDepartment(d, counts.get(d.id) || 0, childCounts.get(d.id) || 0));
  }

  /**
   * 部门改名。校验与创建一致（非空、≤64、同级不重名）。
   *
   * 重名检查必须**排除自己**：否则"把「研发部」改成「研发部」"（值没动）
   * 会被自己的名字挡下，报一句"已有同名部门"却指的就是它自己 —— 那是个把人绕晕的错误。
   */
  function renameDepartment(orgId, id, { name } = {}) {
    const d = orgRepo.getDepartment(orgId, id);
    if (!d) throw errors.notFound('部门不存在');
    const nm = String(name == null ? '' : name).trim();
    if (!nm) throw errors.badRequest('部门名称不能为空');
    if (nm.length > DEPT_NAME_MAX) throw errors.badRequest('部门名称过长（最多 ' + DEPT_NAME_MAX + ' 字）');
    const clash = orgRepo.findDepartmentByName(orgId, nm);
    if (clash && clash.id !== d.id) throw errors.conflict('本组织已有同名部门：' + nm);
    const updated = orgRepo.renameDepartment(orgId, id, nm);
    return publicDepartment(
      updated,
      userRepo.countUsersByDept(orgId).get(id) || 0,
      orgRepo.countDepartmentsByParent(orgId).get(id) || 0
    );
  }

  /**
   * 删除部门。**引用护栏**：被引用时拒绝并说清楚"谁在引用、下一步怎么办"。
   *
   * 为什么不让数据库的 FK 报错？`PRAGMA foreign_keys = ON` 保证引用完整，
   * 但抛出来的是 `FOREIGN KEY constraint failed` —— 给机器看的话。
   * 护栏必须先查引用、给人话拒绝；FK 留作最后一道兜底（单进程同步驱动下，
   * 查与删之间不存在交错，护栏即最终判定）。
   *
   * 顺序上先查成员、再查子部门：成员是更常见的阻塞原因，先说它。
   */
  function deleteDepartment(orgId, id) {
    const d = orgRepo.getDepartment(orgId, id);
    if (!d) throw errors.notFound('部门不存在');
    const members = userRepo.countUsersByDept(orgId).get(id) || 0;
    if (members > 0) {
      throw errors.conflict('部门「' + d.name + '」下还有 ' + members + ' 个成员，'
        + '先把他们改到别的部门（或清空归属）再删除。');
    }
    const children = orgRepo.countDepartmentsByParent(orgId).get(id) || 0;
    if (children > 0) {
      throw errors.conflict('部门「' + d.name + '」下还有 ' + children + ' 个子部门，先处理子部门再删除。');
    }
    orgRepo.deleteDepartment(orgId, id);
    return { ok: true, id, name: d.name };
  }

  /**
   * 改用户的**基本资料**：显示名 与 部门归属，只这两项。
   *
   * 为什么不做成"万能 PUT"：口令、状态、角色、删除各有自己的守卫与副作用
   * （改密/停用要吊销会话、改角色要过 owner 保护、删除要清依赖行），
   * 合并进一个接口只会把这些差异抹平 —— 那才是真正危险的设计。
   *
   * 字段语义用 `undefined` 与 `null` 区分，**这不是吹毛求疵**：
   *   `deptId: undefined` = 这次不改它；`deptId: null` = **清空归属**。
   *   两者搞混会得到一个"改不掉的部门"，而且从界面上完全看不出原因。
   */
  function setUserProfile(orgId, userId, { displayName, deptId } = {}) {
    const target = userRepo.getUser(orgId, userId);
    if (!target) throw errors.notFound('用户不存在');
    const patch = {};
    if (displayName !== undefined) {
      const dn = String(displayName == null ? '' : displayName).trim();
      if (!dn) throw errors.badRequest('姓名不能为空');
      patch.display_name = dn;
    }
    if (deptId !== undefined) {
      patch.dept_id = assertDeptOfOrg(orgId, deptId);   // null / '' → null（清空）
    }
    if (!Object.keys(patch).length) throw errors.badRequest('没有要修改的字段');
    return publicUser(userRepo.updateUser(orgId, userId, patch));
  }

  /** 整组替换组持有的角色。 */
  function setGroupRoles(orgId, groupId, roleKeys) {
    const g = groupRepo.getGroup(orgId, groupId);
    if (!g) throw errors.notFound('组不存在');
    const keys = [...new Set((roleKeys || []).map(String))];
    for (const rk of keys) if (!knownRole(rk)) throw errors.badRequest('未知角色：' + rk);
    withOwnerGuard(orgId, '调整组「' + g.name + '」的角色', () => {
      for (const b of roleRepo.bindingsForSubject('group', groupId)) roleRepo.unbindRole(b.id);
      for (const rk of keys) {
        const role = roleRepo.getRoleByKey(orgId, rk);
        if (!role) throw errors.internal('内置角色缺失：' + rk);
        roleRepo.bindRole({ subjectType: 'group', subjectId: groupId, roleId: role.id, scopeType: 'tenant' });
      }
    });
    return describeGroup(orgId, groupId);
  }

  /** 整组替换成员。有一个成员非法就整体回滚 —— 不做"部分成功"。 */
  function setGroupMembers(orgId, groupId, userIds = []) {
    const g = groupRepo.getGroup(orgId, groupId);
    if (!g) throw errors.notFound('组不存在');
    withOwnerGuard(orgId, '调整组「' + g.name + '」的成员', () => {
      const res = groupRepo.setMembers({ orgId, groupId, userIds });
      if (res.rejected.length) {
        throw errors.badRequest('以下成员无法加入：'
          + res.rejected.map((x) => x.userId + '（' + x.error + '）').join('；'));
      }
    });
    return describeGroup(orgId, groupId);
  }

  /**
   * 把某个用户**定点**移出某个组。
   *
   * 与 `setGroupMembers`（整组替换）的分工：那个服务于"编辑成员名单"的表单
   * （提交的是一份完整名单）；这个服务于名单页上那一行的"移出"按钮 ——
   * 一次点一个。两者不能合成一个：用"整组替换"去实现单点移除，要求前端先提交
   * 一份自己刚读到的名单，两个管理员同时操作时**后提交的会把对方刚加的人抹掉**。
   *
   * 同样过 `withOwnerGuard`：把最后一位生效 owner 从 owner 组里移出，等于组织没人能管。
   */
  function removeGroupMember(orgId, groupId, userId) {
    const g = groupRepo.getGroup(orgId, groupId);
    if (!g) throw errors.notFound('组不存在');
    let removed = 0;
    withOwnerGuard(orgId, '把用户移出组「' + g.name + '」', () => {
      const r = groupRepo.removeMember({ orgId, groupId, userId });
      if (!r.ok) throw errors.badRequest(r.error);
      removed = r.removed;
    });
    if (!removed) throw errors.notFound('该用户不在此组中');
    return { ok: true, id: String(groupId), userId: String(userId), group: describeGroup(orgId, groupId) };
  }

  // ── 凭据 ─────────────────────────────────────────────────────────────

  /** 写入/更新凭据（加密落库）。明文只在这个函数的内存里存在一次。 */
  function setCredential(orgId, { name, provider = '', value }) {
    if (!name) throw errors.badRequest('凭据名称不能为空');
    if (!value) throw errors.badRequest('凭据值不能为空');
    const id = credRepo.upsertCredential({
      orgId, name: String(name), provider: String(provider),
      cipher: encryptSecret(value, masterSecret),
    });
    return credentialInfo(credRepo.getCredentialForUseById(orgId, id));
  }

  /** 列表**不含明文、连密文都不含** —— 只给"有值/没值"。 */
  function listCredentials(orgId) {
    return credRepo.listCredentials(orgId).map((r) => ({
      id: r.id, name: r.name, provider: r.provider,
      hasValue: Number(r.has_cipher) === 1,
      updatedAt: r.updated_at, refCount: r.ref_count,
    }));
  }

  function deleteCredential(orgId, id) {
    const row = credRepo.getCredentialById(orgId, id);
    if (!row) throw errors.notFound('凭据不存在');
    credRepo.deleteCredential(orgId, id);
    return { ok: true, id };
  }

  /**
   * 自检用：确认凭据表**没有任何明文字段**（列名层面就不该存在）。
   *
   * ⚠️ 这条断言自 M1 写下起**从没有被调用过** —— 一次全量体检抓出的"写了但没接通的护栏"。
   * 一个"写了却没跑"的安全断言比没有更危险：它会让人**以为**它在守着。
   * 现在接进 `--check` 自检（见 diagnostics.mjs），并且只在凭据表为空或有密文时都成立。
   */
  function assertNoPlaintextColumns() {
    return credRepo.assertNoPlaintextColumns();
  }

  // ── API Key ──────────────────────────────────────────────────────────

  function createApiKeyFor(userId, { name, scopes = [], ttlMs = null }) {
    if (!name) throw errors.badRequest('API Key 名称不能为空');
    const issued = issueApiKey(masterSecret, { ttlMs });
    apiKeyRepo.createApiKey({
      id: issued.id, userId, name: String(name),
      keyHash: issued.keyHash, scopes, expiresAt: issued.expiresAt,
    });
    // 明文 key **只在此刻返回一次**，之后服务端不再有任何地方能拿到它
    return {
      id: issued.id, name: String(name), key: issued.key, scopes,
      expiresAt: issued.expiresAt,
      warning: '这个 key 只显示这一次。服务端只保存它的哈希，无法再次取出。',
    };
  }

  function listApiKeys(userId) {
    return apiKeyRepo.listForUser(userId).map((k) => ({
      id: k.id, name: k.name, scopes: apiKeyRepo.scopesOf(k),
      expiresAt: k.expires_at, lastUsedAt: k.last_used_at, createdAt: k.created_at,
    }));
  }

  function revokeApiKey(userId, id) {
    const r = apiKeyRepo.revokeApiKey(userId, id);
    if (!r || !r.changes) throw errors.notFound('API Key 不存在');
    return { ok: true, id };
  }

  return {
    setupStatus, requireSetup, status, runSetup,
    login, authenticate, logout, purgeSessions,
    // 两步验证（登录第二步 + 自助登记/停用 + 管理员重置，见实现处的 TOTP 小节）
    loginTotp, totpStatus, totpBeginEnroll, totpConfirmEnroll, totpDisable, totpRegenerateRecoveryCodes, resetUserTotp,
    createUser, importUsers, listUsers, setUserRoles, setUserStatus, resetPassword, deleteUser, setUserProfile,
    // 部门（组织架构，**非权限载体** —— 见实现处的长注释）
    createDepartment, listDepartments, renameDepartment, deleteDepartment,
    // 范围级授权（4.6 库级 ACL 写入端）
    scopedRolesForUser, listScopeBindings, grantScopedRole, revokeScopedRole,
    listRoles,
    listGroups, describeGroup, createGroup, updateGroup, deleteGroup, setGroupRoles, setGroupMembers, removeGroupMember,
    setCredential, listCredentials, deleteCredential, assertNoPlaintextColumns,
    createApiKeyFor, listApiKeys, revokeApiKey,
    publicUser,
  };
}
