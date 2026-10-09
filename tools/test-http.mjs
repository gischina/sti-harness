/**
 * HTTP 端到端回归（M1 验收的核心手段）。
 *
 * 为什么必须有这个脚本（而不是靠手工 curl）：
 *   本轮开发中遇到一个真实缺陷 —— 凭据写入成功，接口却回 `hasValue:false`。
 *   它**不会抛异常、不会打日志**，只在响应体里安静地错一个字段。
 *   手工 curl 能看见，但没人会每次发版都把 20 个接口点一遍。
 *   所以把这些断言固化成脚本：**接口层面的错，必须由接口层面的回归来抓。**
 *
 * 自包含：自己建临时数据目录、自己跑迁移、自己装配服务并监听
 * **随机端口**（`listen(0)`），因此
 *   · 不依赖本机是否已启动服务、也不占用 3090；
 *   · 不会碰到你真实 `data/` 目录里的任何东西。
 * 内核固定用 测试替身（`STI_KERNEL=测试替身`），回归不需要上游在场。
 *
 * 用法：node tools/test-http.mjs
 * 末行输出 `DONE fails=0`。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import assert from 'node:assert/strict';

// ⚠️ 必须在任何 app 模块之前设好：paths.mjs 在**模块求值时**就读 DATA_DIR，
//    而 ESM 的静态 import 会先于本行执行 —— 所以下面所有 app 模块都用动态 import。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-http-'));
process.env.STI_DATA_DIR = tmp;
process.env.STI_LOG_LEVEL = 'error';      // 回归只关心结果，不刷业务日志
// 内核不配地址（0.21.4 起"没配 = 未接入"），改由下面**显式注入测试替身** ——
// 从前是 `STI_KERNEL=mock` 这个环境变量，那个开关连同内核模式一起删掉了。
process.env.STI_RATE_LIMIT = '100000';    // 别让限流把回归自己挡了
process.env.STI_RATE_LIMIT_LOGIN = '100000';  // 登录有独立的更严阈值，回归同样要放到足够大

await import('../app/util/quiet-warnings.mjs');
const { ensureRuntimeDirs, DB_FILE, DATA_DIR, ROOT } = await import('../app/paths.mjs');
const db = await import('../app/data/db.mjs');
const migrate = await import('../app/data/migrate.mjs');
const { loadConfig } = await import('../app/config.mjs');
const { createIdentityService } = await import('../app/platform/identity/service.mjs');
const { createKnowledgeService } = await import('../app/platform/knowledge/service.mjs');
const { createKernel } = await import('../app/kernel/index.mjs');
const { createKernelStub } = await import('./kernel-stub.mjs');
const { reloadKernel } = await import('../app/compose/kernel.mjs');
const { createServer } = await import('../app/http/server.mjs');
const audit = await import('../app/platform/governance/audit.mjs');
const { hashToken } = await import('../app/platform/identity/tokens.mjs');
const { base32Decode, hotp, totpStepAt, TOTP_WINDOW } = await import('../app/platform/identity/totp.mjs');

let total = 0;
let fails = 0;
let skips = 0;
const failures = [];
const skipped = [];

/** 顺序执行一个用例；可返回 `{skip:'原因'}` 表示本条无法执行（单独计数，绝不计入通过）。 */
async function t(name, fn) {
  total++;
  try {
    const r = await fn();
    if (r && r.skip) {
      total--; skips++;
      skipped.push({ name, reason: r.skip });
      console.log('  ~ ' + name);
      console.log('      跳过：' + r.skip);
      return;
    }
    console.log('  \u2713 ' + name);
  } catch (e) {
    fails++;
    failures.push({ name, error: e });
    console.log('  \u2717 ' + name);
    const msg = (e && e.message) ? String(e.message) : String(e);
    for (const line of msg.split('\n').slice(0, 8)) console.log('      ' + line);
  }
}

function section(title) {
  console.log('');
  console.log('── ' + title + ' ' + '─'.repeat(Math.max(0, 56 - title.length)));
}

console.log('');
console.log('STI HARNESS HTTP 端到端回归（M1）');
console.log('='.repeat(64));

/* ── 装配 ────────────────────────────────────────────────────────── */

ensureRuntimeDirs();
db.openDb(DB_FILE);
migrate.migrate();

const MASTER = crypto.randomBytes(32);
const OTHER_SECRET = crypto.randomBytes(32);
const identity = createIdentityService({ masterSecret: MASTER, sessionTtlMs: 3600 * 1000 });
const config = loadConfig();
// 显式注入测试替身：产品路径上没有"没配地址也能用"的内核（那层降级已删），
// 所以回归自己搭一个确定性的 —— 见 tools/kernel-stub.mjs 的文件头。
const stubProvider = createKernelStub();
const kernel = createKernel({ provider: stubProvider, reason: '回归用测试替身（不依赖真实内核）' });

/**
 * 把运行中的门面恢复成测试替身。
 *
 * 为什么需要它：内核接入向导那几个用例会**真的把内核切走**（保存即生效是产品行为），
 * 切到某个桩地址之后它就是"不可用"了 —— 而那些用例后面还有别的用例要用内核。
 * 这里走的是门面自己的 `swap()`（与热切换同一条路径），不是另造一个门面对象。
 */
function restoreStubKernel() {
  kernel.swap({ ready: true, provider: stubProvider, reason: '回归用测试替身（不依赖真实内核）', dshStatus: null });
}
// M2 起，装配 createServer 必须一并给出知识服务：知识路由在装配期就要求 deps.knowledge，
// 少给会在启动时直接抛错（这是刻意的 —— 静默少挂 10 条路由比启动失败更难查）。
// ⚠️ 知识服务还必须与 `app/main.mjs` **同构**装配：少了 `identity` / `resolveScopedRoles`，
//    4.6 的库级 ACL 会静默退化成"只看全局角色"，库级授权接口则直接报"未装配身份服务" ——
//    于是本套端到端回归**永远测不到**库级授权的权限与状态码。这是脚手架与生产装配的漂移。
const knowledge = createKnowledgeService({
  config, audit, resolveCredential: () => null,
  identity,
  resolveScopedRoles: (userId, scopeType) => identity.scopedRolesForUser(userId, scopeType),
});
// M3 起，装配 createServer 必须一并给出治理服务（审计/用量/配额）：
// 治理路由与 quota/audit 中间件在装配期就要求 deps.governance —— 与 M2 的 knowledge 同一纪律。
const { createGovernanceService } = await import('../app/platform/governance/service.mjs');
const { createOperationService } = await import('../app/platform/operation/service.mjs');
const { createModelService } = await import('../app/platform/model/service.mjs');
// P1-2 起还要给出定时任务与出站通知服务（路由在装配期就要求它们，与 M2/M3 同一纪律）
const { createScheduleService } = await import('../app/platform/schedule/service.mjs');
const { createNotifyService } = await import('../app/platform/notify/service.mjs');
const { encryptSecret, decryptSecret } = await import('../app/platform/identity/credentials.mjs');
const operation = createOperationService({ dataDir: DATA_DIR });
const model = createModelService({});
// governance 与 main.mjs 同构：成本核算要"按租户取模型条目"，靠装配层注入。
// ⚠️ 所以 `model` 必须先建好 —— 依赖顺序在装配层是真实的，别用"反正箭头函数晚点才跑"来糊过去。
const governance = createGovernanceService({ resolveProviders: (tid) => model.listProviders(tid) });
// `allowLoopback: true` 只在测试里给：本套回归要真的往 127.0.0.1 上的桩服务器投递，
// 而生产默认禁止回环出站（那是 SSRF 的典型载荷）。
const notify = createNotifyService({ masterSecret: MASTER, encryptSecret, decryptSecret, allowLoopback: true });
const schedule = createScheduleService({ governance, operation, model, notify });
// 0.21.0 工作区服务：与 main.mjs 同构装配（identity + 审计）。少了它工作区路由在
// 装配期直接报错 —— 与 knowledge/governance 的同一纪律：路由表是唯一真源，缺一组必须立刻可见。
const { createWorkspaceService } = await import('../app/platform/workspace/service.mjs');
const workspace = createWorkspaceService({ identity, audit });
const { server, router } = createServer({
  config, kernel, identity, knowledge, workspace, governance, operation, model, notify, schedule,
  paths: { DATA_DIR }, startedAt: Date.now(),
  // 内核接入向导要把令牌以密文写进 config.json —— 注入的是"加密能力"，不是主密钥本身。
  encryptSecret: (plain) => encryptSecret(plain, MASTER),
  // 0.21.3 内核热切换：路由层调这个能力把新装配换进正在跑的门面。
  // ⚠️ 缺了它，接口会**如实降级**成"需要重启" —— 于是"保存即生效"这条路径
  // 在回归里静默测不到（这就是"新能力进路由表 = 所有脚本补同样装配"那条纪律的由来：
  // 少接一根线不会报错，只会让断言测了个寂寞）。
  switchKernel: () => reloadKernel({ config, keyring: MASTER, kernel }),
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const PORT = server.address().port;
const BASE = 'http://127.0.0.1:' + PORT;
const HOST = '127.0.0.1:' + PORT;

const ADMIN = { username: 'admin', password: 'Adm1n-Pass!23' };

/** 发一个请求。`cookie` 传完整 cookie 串；`headers` 用于 CSRF / 探测类用例。 */
async function call(method, p, { token, cookie, json, headers = {} } = {}) {
  const h = { ...headers };
  if (json !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  if (cookie) h.cookie = cookie;
  const res = await fetch(BASE + p, {
    method, headers: h, body: json === undefined ? undefined : JSON.stringify(json), redirect: 'manual',
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON 就留 null，由用例决定怎么处理 */ }
  return {
    status: res.status,
    headers: res.headers,
    body,
    text,
    setCookies: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
  };
}

/** 从 Set-Cookie 里取出 `sti_session=<值>` 这一段，用于后续以 Cookie 身份发请求 */
function cookiePair(setCookies) {
  const hit = (setCookies || []).find((c) => c.startsWith('sti_session='));
  return hit ? hit.split(';')[0] : null;
}

let adminToken = null;      // owner 的会话令牌
let adminCookie = null;
let viewerToken = null;
let orgId = null;
let viewerId = null;
let apiKeyId = null;

/* ── 1. 初始化前的门禁 ───────────────────────────────────────────── */

section('初始化前：未登录一律 401');

await t('安全响应头：API 与静态页都带上 nosniff / DENY / 无来源 / CSP', async () => {
  const api = await call('GET', '/api/health');
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(api.headers.get('x-frame-options'), 'DENY');
  assert.equal(api.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(/default-src 'self'/.test(api.headers.get('content-security-policy') || ''),
    'API 响应也要带 CSP，实际 ' + api.headers.get('content-security-policy'));
  // 明文回归里不应出现 HSTS（经 TLS 才生效，明文发会误导"已上 TLS"）
  assert.equal(api.headers.get('strict-transport-security'), null);

  // 静态页是最容易漏掉安全头的出口（它不走路由链）
  const idx = await fetch(BASE + '/');
  assert.equal(idx.status, 200);
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff', '静态页也必须带安全头');
  const idxCsp = idx.headers.get('content-security-policy') || '';
  assert.ok(/frame-ancestors 'none'/.test(idxCsp));
  // P1-3 / 3.4：真实响应里的 script-src 不得再含 unsafe-inline（端到端钉住，而不只是纯函数断言）
  assert.ok(/script-src 'self'/.test(idxCsp), 'script-src 应为 self，实际 ' + idxCsp);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(idxCsp), 'script-src 不得含 unsafe-inline，实际 ' + idxCsp);

  // 首屏脚本已外链：boot.js 必须真的能被取到（取不到 = 页面暗色闪白 + file:// 兜底失效）
  const boot = await fetch(BASE + '/boot.js');
  assert.equal(boot.status, 200, 'boot.js 应可访问（首屏脚本已外链）');
  assert.match(boot.headers.get('content-type') || '', /javascript/, 'boot.js 应以 JS 类型返回');

  // index.html 里不得再有内联 <script>（CSP 已不含 unsafe-inline，浏览器会拒绝执行它）
  const idxHtml = await idx.text();
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(idxHtml.replace(/<!--[\s\S]*?-->/g, '')),
    'index.html 不得再有内联 <script>');
});

await t('健康检查与平台状态是 public（不需要登录，也不含敏感数据）', async () => {
  const h = await call('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);

  const s = await call('GET', '/api/system/status');
  assert.equal(s.status, 200);
  assert.equal(s.body.kernel.ready, true, '回归固定用测试替身，应报"已接入"');
  // 上游令牌只报"有没有"，绝不回报内容
  assert.equal(typeof s.body.config.values.hasToken, 'boolean');
  assert.ok(!('dshToken' in s.body.config.values), '平台状态不得回显上游令牌');
});

await t('初始化状态如实报告"还没初始化"，且不向未认证者泄露规模', async () => {
  const r = await call('GET', '/api/identity/setup');
  assert.equal(r.status, 200);
  assert.equal(r.body.setup.needsSetup, true);
  assert.equal(r.body.setup.initialized, false);
  assert.equal(r.body.setup.org, null, '空库不该报出组织');
  // 这是 **public** 接口：账号数 / 组织数是"这家公司有多大"的规模情报。
  // 把它送给任何能碰到端口的人没有收益，只有风险 —— 用**负面断言**把这条边界钉住，
  // 免得哪天有人"顺手加回去"（它曾经就在响应里，是 0.15.0 去掉的）。
  assert.ok(!('userCount' in r.body.setup), '未认证接口不得回显账号数');
  assert.ok(!('orgCount' in r.body.setup), '未认证接口不得回显组织数');
});

await t('未登录访问受保护接口 → 401（逐条覆盖三类接口）', async () => {
  for (const p of ['/api/identity/me', '/api/identity/users', '/api/identity/credentials',
    '/api/identity/apikeys', '/api/kernel/sessions']) {
    const r = await call('GET', p);
    assert.equal(r.status, 401, p + ' 应回 401，实际 ' + r.status);
    assert.equal(r.body.error.code, 'unauthorized');
  }
});

await t('畸形/伪造令牌一律 401，且**不泄漏**失败原因差异', async () => {
  const cases = ['', 'garbage', 'sti_fake.value', 'stik_fake.value', 'Bearer x'];
  const msgs = new Set();
  for (const tk of cases) {
    const r = await call('GET', '/api/identity/me', { token: tk });
    assert.equal(r.status, 401, '令牌 ' + JSON.stringify(tk) + ' 应回 401');
    msgs.add(r.body.error.message);
  }
  assert.equal(msgs.size, 1, '不同失败原因必须回同一句提示（否则接口会变成令牌探测器）');
});

/* ── 2. 初始化向导 ───────────────────────────────────────────────── */

section('初始化向导');

await t('口令强度下限在服务端生效（不靠前端）', async () => {
  const weak = await call('POST', '/api/identity/setup', {
    json: { orgName: '测试组织', adminUsername: 'admin', adminPassword: '123' },
  });
  assert.equal(weak.status, 400);
  assert.match(weak.body.error.message, /口令/);

  const badName = await call('POST', '/api/identity/setup', {
    json: { orgName: '测试组织', adminUsername: '有中文', adminPassword: ADMIN.password },
  });
  assert.equal(badName.status, 400);
});

await t('初始化成功：建组织 + 物化 4 个内置角色 + 管理员 + 加密凭据', async () => {
  const r = await call('POST', '/api/identity/setup', {
    json: {
      orgName: '某某公司',
      adminUsername: ADMIN.username,
      adminPassword: ADMIN.password,
      adminDisplayName: '平台管理员',
      credential: { name: 'model-key', provider: 'openai-compatible', value: 'sk-setup-secret-000' },
    },
  });
  assert.equal(r.status, 201, '实际 ' + r.status + '：' + r.text.slice(0, 200));
  assert.deepEqual(r.body.rolesCreated.sort(), ['admin', 'member', 'owner', 'viewer']);
  assert.deepEqual(r.body.admin.roles, ['owner']);

  // ★ 这条是回归本位：验证"刚写入的凭据有没有值"。
  //   曾经的真 bug —— 写入成功、却回 hasValue:false（列表查询刻意不带 cipher 列，
  //   credentialInfo 就误判成"没值"）。它不抛错、不打日志，只在响应体里安静地错。
  assert.equal(r.body.credential.hasValue, true,
    '刚写入的凭据必须报告"有值"。报 false 说明判定又依赖了不带 cipher 的查询');
  assert.equal(r.body.credential.name, 'model-key');
  // 明文绝不能回显
  assert.ok(!r.text.includes('sk-setup-secret-000'), '初始化响应里不得回显凭据明文');

  orgId = r.body.org.id;
});

await t('重复初始化被拒绝（409），不会产生第二个组织', async () => {
  const r = await call('POST', '/api/identity/setup', {
    json: { orgName: '另一个组织', adminUsername: 'admin2', adminPassword: ADMIN.password },
  });
  assert.equal(r.status, 409);
  const st = await call('GET', '/api/identity/setup');
  assert.equal(st.body.setup.needsSetup, false);
  assert.equal(st.body.setup.initialized, true);
  // 组织数不再对外暴露，所以改用**更直接**的证据：报出来的还是第一个组织，
  // 而不是"另一个组织" —— 这比数个数更贴近要找的事实。
  assert.ok(st.body.setup.org, '已初始化就该报出组织');
  assert.equal(st.body.setup.org.name, '某某公司', '不得变成第二次请求里的组织');
  assert.equal(st.body.setup.org.id, orgId, '组织 id 必须还是第一次建的那个');
});

/* ── 3. 登录 ─────────────────────────────────────────────────────── */

section('登录与会话');

await t('口令错误与账号不存在**不可区分**（同状态码、同 code、同文案）', async () => {
  const wrongPwd = await call('POST', '/api/identity/login', {
    json: { username: ADMIN.username, password: 'Wrong-Pass!99' },
  });
  const noUser = await call('POST', '/api/identity/login', {
    json: { username: 'nobody-here', password: 'Wrong-Pass!99' },
  });
  assert.equal(wrongPwd.status, 401);
  assert.equal(noUser.status, 401);
  assert.equal(wrongPwd.body.error.code, noUser.body.error.code);
  assert.equal(wrongPwd.body.error.message, noUser.body.error.message,
    '两种情况文案必须一致 —— 否则登录接口就是账号枚举器');
});

await t('正确登录 → 200 + 令牌 + httpOnly/SameSite Cookie', async () => {
  const r = await call('POST', '/api/identity/login', { json: ADMIN });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.match(r.body.token, /^sti_[A-Za-z0-9_]+\./, '会话令牌应有 sti_ 前缀');
  assert.equal(r.body.user.username, ADMIN.username);
  assert.deepEqual(r.body.user.roles, ['owner']);
  assert.ok(!('pwd_hash' in r.body.user) && !('pwdSalt' in r.body.user), '用户对象不得带口令字段');

  const sc = r.setCookies.join(' | ');
  assert.match(sc, /sti_session=/, '应下发会话 cookie');
  assert.match(sc, /HttpOnly/, 'cookie 必须 HttpOnly（防 XSS 读走令牌）');
  assert.match(sc, /SameSite=Lax/, 'cookie 必须 SameSite=Lax（CSRF 第一道防线）');
  assert.match(sc, /Max-Age=\d+/, '应带有效期');

  adminToken = r.body.token;
  adminCookie = cookiePair(r.setCookies);
  assert.ok(adminCookie, 'cookie 值应能被解析出来');
});

await t('令牌可经三种方式携带（Bearer / x-sti-token / Cookie）', async () => {
  const a = await call('GET', '/api/identity/me', { token: adminToken });
  assert.equal(a.status, 200);
  assert.equal(a.body.auth.via, 'authorization');
  assert.equal(a.body.auth.credential, 'session');

  const b = await call('GET', '/api/identity/me', { headers: { 'x-sti-token': adminToken } });
  assert.equal(b.status, 200);
  assert.equal(b.body.auth.via, 'x-sti-token');

  const c = await call('GET', '/api/identity/me', { cookie: adminCookie });
  assert.equal(c.status, 200);
  assert.equal(c.body.auth.via, 'cookie');
  assert.equal(c.body.auth.credential, 'session', 'Cookie 装的是会话令牌，不是 API Key');
});

await t('**不支持** query string 携带令牌（URL 会进日志/历史/Referer）', async () => {
  const r = await call('GET', '/api/identity/me?token=' + encodeURIComponent(adminToken));
  assert.equal(r.status, 401, '把令牌放 URL 里必须无效 —— 这是刻意的，不是缺功能');
});

/* ── 4. 权限 ─────────────────────────────────────────────────────── */

section('权限矩阵与越权');

await t('/me 返回完整权限矩阵，owner 为全权', async () => {
  const r = await call('GET', '/api/identity/me', { token: adminToken });
  assert.equal(r.status, 200);
  const m = r.body.permissions;
  assert.ok(m.org && m.user && m.credential, '权限矩阵应含各资源');
  for (const res of Object.keys(m)) {
    for (const act of Object.keys(m[res])) {
      assert.equal(m[res][act], true, 'owner 对 ' + res + ':' + act + ' 应为 true');
    }
  }
  assert.match(r.body.permissionsMeta.rules, /未知角色一律拒绝/);
});

await t('已实装的中间件不再自报为"占位"（诚实约定的回归）', async () => {
  const r = await call('GET', '/api/identity/me', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-sti-passthrough'), null,
    'M3 后 quota/audit 也已实装，链上不再有占位中间件 —— 该头应整体消失（它若出现说明有中间件退化了）');

  const mw = await call('GET', '/api/system/middleware');
  const byName = Object.fromEntries(mw.body.middlewares.map((m) => [m.name, m.state]));
  for (const n of ['auth', 'tenant', 'rbac', 'quota', 'audit']) {
    assert.equal(byName[n], 'active', n + ' 已实装，状态应是 active');
  }
});

await t('建一个 viewer 账号（只读访客）', async () => {
  const r = await call('POST', '/api/identity/users', {
    token: adminToken,
    json: { username: 'viewer1', password: 'V13wer-Pass!', displayName: '观摩账号', roles: ['viewer'] },
  });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  assert.deepEqual(r.body.user.roles, ['viewer']);
  viewerId = r.body.user.id;

  const lg = await call('POST', '/api/identity/login', {
    json: { username: 'viewer1', password: 'V13wer-Pass!' },
  });
  assert.equal(lg.status, 200);
  viewerToken = lg.body.token;
});

await t('viewer 的权限矩阵是只读：写/执行一律 false', async () => {
  const r = await call('GET', '/api/identity/me', { token: viewerToken });
  assert.equal(r.body.permissions.user.read, true, 'viewer 应能读用户列表（有意保留的只读可见性）');
  assert.equal(r.body.permissions.user.write, false);
  assert.equal(r.body.permissions.credential.read, false, 'viewer 不该看到凭据');
  assert.equal(r.body.permissions.session.execute, false, 'viewer 不能跑 Agent');
});

await t('越权写 → 403，且响应体说清"缺什么"与"我有什么"', async () => {
  const r = await call('POST', '/api/identity/users', {
    token: viewerToken,
    json: { username: 'should-not-exist', password: 'Xx123456!' },
  });
  assert.equal(r.status, 403, 'viewer 建用户应被拒，实际 ' + r.status);
  assert.equal(r.body.error.code, 'forbidden');
  assert.deepEqual(r.body.error.detail.needs, ['user:write']);
  assert.deepEqual(r.body.error.detail.roles, ['viewer']);

  // 确认真的没写进去
  const list = await call('GET', '/api/identity/users', { token: adminToken });
  assert.ok(!list.body.users.some((u) => u.username === 'should-not-exist'), '被拒的请求不得产生副作用');
});

await t('越权访问凭据 / 改角色 → 403', async () => {
  const cred = await call('GET', '/api/identity/credentials', { token: viewerToken });
  assert.equal(cred.status, 403);

  const rol = await call('PUT', '/api/identity/users/' + viewerId + '/roles', {
    token: viewerToken, json: { roles: ['owner'] },
  });
  assert.equal(rol.status, 403, 'viewer 不能给自己提权');

  // 提权必须确实没生效
  const me = await call('GET', '/api/identity/me', { token: viewerToken });
  assert.deepEqual(me.body.user.roles, ['viewer']);
});

await t('合法只读访问放行：viewer 能看用户列表（403 不是因为"全都拦"）', async () => {
  const r = await call('GET', '/api/identity/users', { token: viewerToken });
  assert.equal(r.status, 200, 'viewer 有 user:read，应放行');
  assert.ok(Array.isArray(r.body.users) && r.body.users.length >= 2);
  assert.ok(!JSON.stringify(r.body).includes('pwd'), '用户列表不得带出口令字段');
});

await t('改角色：可升可降，但**不能移除组织最后一个所有者**', async () => {
  const up = await call('PUT', '/api/identity/users/' + viewerId + '/roles', {
    token: adminToken, json: { roles: ['member'] },
  });
  assert.equal(up.status, 200, up.text.slice(0, 200));
  assert.deepEqual(up.body.user.roles, ['member']);

  const back = await call('PUT', '/api/identity/users/' + viewerId + '/roles', {
    token: adminToken, json: { roles: ['viewer'] },
  });
  assert.equal(back.status, 200);
  assert.deepEqual(back.body.user.roles, ['viewer']);

  const bad = await call('PUT', '/api/identity/users/' + viewerId + '/roles', {
    token: adminToken, json: { roles: ['superuser'] },
  });
  assert.equal(bad.status, 400, '未知角色必须被拒（绝不能被当成"通配"放行）');

  // 这是"组织不会把自己锁死"的保护：最后一个 owner 降权后，就没人能管这个组织了
  const me = await call('GET', '/api/identity/me', { token: adminToken });
  const los = await call('PUT', '/api/identity/users/' + me.body.user.id + '/roles', {
    token: adminToken, json: { roles: ['admin'] },
  });
  assert.equal(los.status, 409, '不应允许移除组织最后一个所有者');
  assert.match(los.body.error.message, /所有者/);

  // 同样不能停用最后一个 owner
  const dis = await call('PUT', '/api/identity/users/' + me.body.user.id + '/status', {
    token: adminToken, json: { status: 'disabled' },
  });
  assert.equal(dis.status, 409);
});

/* ── 6. 令牌落库形态 ─────────────────────────────────────────────── */

section('令牌只以哈希形式落库');

await t('库里存的是 HMAC(masterSecret, token)，不是 token 本身', async () => {
  const rows = db.all('SELECT id, token_hash FROM auth_sessions');
  assert.ok(rows.length >= 2, '应有管理员与 viewer 两条会话');

  const login = await call('POST', '/api/identity/login', { json: ADMIN });
  const token = login.body.token;
  const expected = hashToken(token, MASTER);

  // ★ 直接按"期望的哈希"回查：查得到，就说明落库的正是 HMAC(主密钥, 令牌)
  const row = db.get('SELECT token_hash FROM auth_sessions WHERE token_hash = ?', [expected]);
  assert.ok(row, '库里没有 HMAC(主密钥, 令牌) 对应的行 —— 说明落库的不是这个哈希');
  assert.notEqual(row.token_hash, token, '绝不能明文存令牌');
  assert.match(row.token_hash, /^[0-9a-f]{64}$/, '应是 SHA-256 长度的十六进制');
  assert.notEqual(row.token_hash, hashToken(token, OTHER_SECRET),
    '换个主密钥算出来必须不一样 —— 这就是"库被拷走也伪造不了令牌"的依据');

  // 直接把库里的哈希拿来当令牌用 → 进不来
  const forged = await call('GET', '/api/identity/me', { token: row.token_hash });
  assert.equal(forged.status, 401, '库里的哈希不能当令牌用');

  // 整表扫描：任何一列都不等于某个有效令牌
  const all = db.all('SELECT * FROM auth_sessions');
  assert.ok(!JSON.stringify(all).includes(token), '会话表里不得出现令牌明文');
});

await t('会话可吊销：登出后原令牌立即失效', async () => {
  const lg = await call('POST', '/api/identity/login', { json: ADMIN });
  const tk = lg.body.token;
  assert.equal((await call('GET', '/api/identity/me', { token: tk })).status, 200);

  const out = await call('POST', '/api/identity/logout', { token: tk });
  assert.equal(out.status, 200);
  assert.ok(out.setCookies.some((c) => /Max-Age=0/.test(c)), '登出应清 cookie');

  assert.equal((await call('GET', '/api/identity/me', { token: tk })).status, 401, '登出后令牌必须失效');
});

await t('改密后该用户的旧会话全部失效（不是只失效当前一个）', async () => {
  const lg = await call('POST', '/api/identity/login', { json: { username: 'viewer1', password: 'V13wer-Pass!' } });
  const old = lg.body.token;
  assert.equal((await call('GET', '/api/identity/me', { token: old })).status, 200);

  const rp = await call('POST', '/api/identity/users/' + viewerId + '/password', {
    token: adminToken, json: { password: 'New-V13wer-Pass!' },
  });
  assert.equal(rp.status, 200);
  assert.equal((await call('GET', '/api/identity/me', { token: old })).status, 401, '改密后旧会话必须失效');

  const relogin = await call('POST', '/api/identity/login', {
    json: { username: 'viewer1', password: 'New-V13wer-Pass!' },
  });
  assert.equal(relogin.status, 200, '新口令应可登录');
  viewerToken = relogin.body.token;

  const oldPwd = await call('POST', '/api/identity/login', {
    json: { username: 'viewer1', password: 'V13wer-Pass!' },
  });
  assert.equal(oldPwd.status, 401, '旧口令必须失效');
});

/* ── 7. 凭据 ─────────────────────────────────────────────────────── */

section('凭据加密');

await t('凭据列表只回元信息：无明文、**连密文也不回**', async () => {
  const r = await call('GET', '/api/identity/credentials', { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.credentials.length >= 1);
  const allowed = new Set(['id', 'name', 'provider', 'hasValue', 'updatedAt', 'refCount']);
  for (const c of r.body.credentials) {
    for (const k of Object.keys(c)) {
      assert.ok(allowed.has(k), '凭据列表出现了不该有的字段：' + k);
    }
    assert.equal(c.hasValue, true, '已写入的凭据应有值');
  }
  assert.ok(!/sk-/.test(r.text), '响应里不得出现任何像密钥的明文');
  assert.ok(!r.text.includes('cipher'), '响应里不得出现密文字段');
});

await t('写入新凭据：落库是密文，且同一明文两次加密结果不同', async () => {
  const PLAIN = 'sk-live-abcdef1234567890';
  const a = await call('POST', '/api/identity/credentials', {
    token: adminToken, json: { name: 'prod-key', provider: 'openai', value: PLAIN },
  });
  assert.equal(a.status, 201);
  assert.equal(a.body.credential.hasValue, true);
  assert.ok(!a.text.includes(PLAIN), '响应不得回显明文');

  const b = await call('POST', '/api/identity/credentials', {
    token: adminToken, json: { name: 'prod-key-2', provider: 'openai', value: PLAIN },
  });
  assert.equal(b.status, 201);

  const rows = db.all("SELECT id, name, cipher FROM credentials WHERE name IN ('prod-key','prod-key-2')");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.notEqual(row.cipher, PLAIN, '落库绝不能是明文');
    assert.ok(!String(row.cipher).includes(PLAIN), '密文里不得夹带明文片段');
  }
  assert.notEqual(rows[0].cipher, rows[1].cipher,
    '同一明文加密两次必须不同（每次新 IV）—— 否则能通过比对密文猜出"两人的密钥是不是同一个"');

  // 密文能被主密钥解回明文（证明它确实只是"加密存储"而不是"存了个没用的东西"）
  const { decryptSecret } = await import('../app/platform/identity/credentials.mjs');
  assert.equal(decryptSecret(rows[0].cipher, MASTER), PLAIN);
  assert.throws(() => decryptSecret(rows[0].cipher, OTHER_SECRET), /解密失败/, '换密钥必须解不开');
});

await t('凭据表在**列名层面**就没有明文字段', async () => {
  const cols = db.all("PRAGMA table_info('credentials')").map((c) => c.name);
  const suspicious = cols.filter((c) => /plain|secret|token|key|password|value/i.test(c) && c !== 'cipher');
  assert.deepEqual(suspicious, [], '出现了可疑列名：' + suspicious.join(', '));
});

await t('凭据删除生效，且删除不存在的不报 500', async () => {
  const list = await call('GET', '/api/identity/credentials', { token: adminToken });
  const target = list.body.credentials.find((c) => c.name === 'prod-key-2');
  const del = await call('DELETE', '/api/identity/credentials/' + target.id, { token: adminToken });
  assert.equal(del.status, 200);

  const after = await call('GET', '/api/identity/credentials', { token: adminToken });
  assert.ok(!after.body.credentials.some((c) => c.name === 'prod-key-2'));

  const missing = await call('DELETE', '/api/identity/credentials/cred_does_not_exist', { token: adminToken });
  assert.equal(missing.status, 404);
});

/* ── 8. API Key ──────────────────────────────────────────────────── */

section('API Key（集成用长期令牌）');

await t('创建 API Key：明文只出现这一次，库里只有哈希', async () => {
  const r = await call('POST', '/api/identity/apikeys', { token: adminToken, json: { name: 'ci-pipeline' } });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  const key = r.body.apiKey.key;
  assert.match(key, /^stik_[A-Za-z0-9_]+\./, 'API Key 应有 stik_ 前缀以便与会话令牌区分');
  assert.match(r.body.apiKey.warning, /只显示这一次/);
  apiKeyId = r.body.apiKey.id;

  const row = db.get('SELECT * FROM api_keys WHERE id = ?', [apiKeyId]);
  assert.equal(row.key_hash, hashToken(key, MASTER));
  assert.ok(!JSON.stringify(row).includes(key), 'API Key 表不得出现明文');

  // 再次列出来时，不再有明文
  const list = await call('GET', '/api/identity/apikeys', { token: adminToken });
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(key), '列表接口不得回显 key 明文');
  assert.ok(!('key' in list.body.keys[0]), '列表项只应有元信息');
});

await t('API Key 可当身份用（via=api-key），吊销后立即失效', async () => {
  const created = await call('POST', '/api/identity/apikeys', { token: adminToken, json: { name: 'ci-2' } });
  const key = created.body.apiKey.key;

  const me = await call('GET', '/api/identity/me', { token: key });
  assert.equal(me.status, 200, 'API Key 应能认证');
  assert.equal(me.body.auth.credential, 'api-key', '凭证**种类**应是 api-key');
  assert.equal(me.body.auth.via, 'authorization', '携带**方式**仍是 Authorization 头（两者不是一回事）');
  assert.equal(me.body.user.username, ADMIN.username);

  const rev = await call('DELETE', '/api/identity/apikeys/' + created.body.apiKey.id, { token: adminToken });
  assert.equal(rev.status, 200);
  assert.equal((await call('GET', '/api/identity/me', { token: key })).status, 401, '吊销后必须失效');

  const again = await call('DELETE', '/api/identity/apikeys/' + created.body.apiKey.id, { token: adminToken });
  assert.equal(again.status, 404, '重复吊销应 404，不该 500');
});

await t('API Key 属主隔离：别人的 key 不能被我吊销', async () => {
  const created = await call('POST', '/api/identity/apikeys', { token: adminToken, json: { name: 'admin-only' } });
  const r = await call('DELETE', '/api/identity/apikeys/' + created.body.apiKey.id, { token: viewerToken });
  assert.equal(r.status, 404, 'API Key 按属主删除 —— 别人删不到（且不泄漏它是否存在）');
});

/* ── 9. CSRF ─────────────────────────────────────────────────────── */

section('CSRF（Cookie 认证的状态变更请求）');

await t('跨站来源的 Cookie 写请求被拒（403 csrf_blocked）', async () => {
  const r = await call('POST', '/api/identity/apikeys', {
    cookie: adminCookie,
    headers: { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' },
    json: { name: 'csrf-should-fail' },
  });
  assert.equal(r.status, 403, '实际 ' + r.status + '：' + r.text.slice(0, 200));
  assert.equal(r.body.error.code, 'csrf_blocked');

  // 未被写进去
  const list = await call('GET', '/api/identity/apikeys', { token: adminToken });
  assert.ok(!list.body.keys.some((k) => k.name === 'csrf-should-fail'));
});

await t('同源 Origin 的 Cookie 写请求正常放行（不是一刀切拦掉 cookie）', async () => {
  const r = await call('POST', '/api/identity/apikeys', {
    cookie: adminCookie,
    headers: { 'sec-fetch-site': 'same-origin', origin: 'http://' + HOST },
    json: { name: 'same-origin-ok' },
  });
  assert.equal(r.status, 201, r.text.slice(0, 200));

  // Origin 与 Host 不一致也必须拒
  const bad = await call('POST', '/api/identity/apikeys', {
    cookie: adminCookie,
    headers: { origin: 'http://127.0.0.1:1' },
    json: { name: 'origin-mismatch' },
  });
  assert.equal(bad.status, 403);
});

await t('Bearer / 头令牌不受 CSRF 约束（脚本不是 CSRF 威胁模型）', async () => {
  const r = await call('POST', '/api/identity/apikeys', {
    token: adminToken,
    headers: { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' },
    json: { name: 'bearer-ok' },
  });
  assert.equal(r.status, 201, 'Bearer 是调用方显式带的，浏览器不会自动附加 → 不受 CSRF 影响');
});

await t('CSRF 被拒也留审计（auth.csrf / denied）', async () => {
  const org = audit.list(orgId, { limit: 500 });
  const hit = org.filter((r) => r.action === 'auth.csrf' && r.result === 'denied');
  assert.ok(hit.length >= 2, 'CSRF 拦截必须留痕（sec-fetch-site 与 origin 两条路径各一次）');
  const details = hit.map((r) => JSON.parse(r.detail_json));
  const bySource = Object.fromEntries(details.map((d) => [d.source, d.reason]));
  assert.equal(bySource['sec-fetch-site'], 'csrf_cross_site');
  assert.equal(bySource.origin, 'csrf_origin_mismatch');
  assert.ok(hit.every((r) => /^usr_/.test(r.user_id)), 'CSRF 审计要记下"是谁的 cookie 被拿去跨站用了"');
  assert.ok(details.every((d) => typeof d.host === 'string' && d.host), '审计要记下当时请求的 Host，便于事后复现');
});

/* ── 10. 审计 ────────────────────────────────────────────────────── */

section('审计留痕（跑在最后：这里才看得到全部动作）');

await t('被拒绝的访问在审计里留下 denied（匿名与已登录两类都要有）', async () => {
  // 说明：这里**直读审计模块**断言内容细节（reason/角色等）；
  //       走 HTTP 的审计查询在 tools/test-governance.mjs 里测（M3 起该接口已交付）。
  const anon = audit.list(audit.ANONYMOUS_TENANT, { limit: 500 });
  const anonDenied = anon.filter((r) => r.action === 'auth.authenticate' && r.result === 'denied');
  assert.ok(anonDenied.length >= 1, '未登录被拒必须留痕');
  assert.ok(anonDenied.some((r) => JSON.parse(r.detail_json).reason === 'no_token'));
  assert.ok(anonDenied.some((r) => JSON.parse(r.detail_json).reason === 'invalid_token'));

  const org = audit.list(orgId, { limit: 500 });
  const rbacDenied = org.filter((r) => r.action === 'access.denied' && r.result === 'denied');
  assert.ok(rbacDenied.length >= 2, '越权必须留痕（实际 ' + rbacDenied.length + ' 条）');
  const d = JSON.parse(rbacDenied[0].detail_json);
  assert.deepEqual(d.roles, ['viewer'], '审计要记下"当时是什么角色"');
  assert.equal(typeof d.reason, 'string');
  assert.ok(rbacDenied.every((r) => r.user_id === viewerId), '审计要记下"是谁"');
});

await t('敏感操作同样留痕：登录 / 建用户 / 改角色 / 写凭据 / 建 API Key', async () => {
  const org = audit.list(orgId, { limit: 500 });
  const actions = new Set(org.map((r) => r.action));
  for (const a of ['identity.login', 'identity.user.create', 'identity.user.set-roles',
    'identity.user.reset-password', 'identity.credential.set', 'identity.apikey.create']) {
    assert.ok(actions.has(a), '缺少审计动作：' + a);
  }
  assert.ok(audit.count(orgId) >= 5, '审计条数应反映本轮的完整操作');
});

await t('审计是哈希链，重算后一致（未篡改）', async () => {
  const v = audit.verifyChain(orgId);
  assert.equal(v.ok, true, '审计链应完整；断裂点：' + JSON.stringify(v.brokenAt));
  assert.ok(v.checked >= 5);

  const v2 = audit.verifyChain(audit.ANONYMOUS_TENANT);
  assert.equal(v2.ok, true);
});

await t('篡改任意一行后，校验能定位到首个断裂点（证明链真的在起作用）', async () => {
  // 这条是"审计链不是摆设"的反证：如果不改数据也报 ok、改了就报 ok，说明校验根本没算。
  const rows = db.all('SELECT rowid, id, detail_json FROM audit_logs WHERE tenant_id = ? ORDER BY at ASC, rowid ASC', [orgId]);
  assert.ok(rows.length >= 3);
  const victim = rows[1];
  const before = audit.verifyChain(orgId);
  assert.equal(before.ok, true);

  db.run('UPDATE audit_logs SET detail_json = ? WHERE rowid = ?', ['{"tampered":true}', victim.rowid]);
  const after = audit.verifyChain(orgId);
  assert.equal(after.ok, false, '改过审计行之后必须报断裂');
  assert.equal(after.brokenAt.id, victim.id, '应准确定位到被改的那一行');
  assert.equal(after.checked, 1, '第一个断裂点应在索引 1（索引 0 未被动过）');

  // 改回来（本用例只做验证，不给后面的用例留脏数据）
  db.run('UPDATE audit_logs SET detail_json = ? WHERE rowid = ?', [victim.detail_json, victim.rowid]);
  assert.equal(audit.verifyChain(orgId).ok, true, '复原后应重新通过');
});

/* ── 11. 路由语义 ────────────────────────────────────────────────── */

section('路由语义（404 / 405 / 501）');

await t('规划路由表已清空：M0~M5 全部交付，"501 占位"机制保留待用', async () => {
  // M5 的备份接口已交付（见 test-governance.mjs 的备份与恢复 section），
  // PLANNED_ROUTES 从此为空 —— 空表本身就是一条断言（"没有没做的接口"）。
  const { PLANNED_ROUTES } = await import('../app/http/routes/index.mjs');
  assert.equal(PLANNED_ROUTES.length, 0, '规划表应为空：' + JSON.stringify(PLANNED_ROUTES));
  // 原规划路由已转正：不再是 501，而是要求管理员身份（未带令牌 → 401）
  const r = await call('POST', '/api/operation/backup');
  assert.equal(r.status, 401, '已交付接口应走正常鉴权而不是 501');
});

await t('不存在的路径 → 404，且提示去哪看接口清单', async () => {
  const r = await call('GET', '/api/nope/nothing');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
  assert.match(r.body.error.hint, /\/api\/system\/routes/);
});

await t('方法不对 → 405 且带 Allow 头（不落进 404）', async () => {
  const r = await call('DELETE', '/api/identity/me', { token: adminToken });
  assert.equal(r.status, 405);
  assert.equal(r.body.error.code, 'method_not_allowed');
  assert.match(r.headers.get('allow') || '', /GET/);
});

await t('路由表如实反映当前交付状态（不报"规划中"的已交付路由）', async () => {
  const r = await call('GET', '/api/system/routes');
  assert.equal(r.status, 200);
  const stats = r.body.stats;
  assert.ok(stats.total >= 40, '路由总数应包含 M0+M1 与规划项，实际 ' + stats.total);
  const ids = r.body.routes.map((x) => x.id);
  // M2 的 10 条知识路由必须真的挂在表里 —— 装配时少给 deps.knowledge 会直接抛错，
  // 但"给了却漏挂"只会表现成 404，比启动失败更难查，所以这里逐个点名。
  for (const m2 of ['knowledge.status', 'knowledge.bases', 'knowledge.bases.create', 'knowledge.bases.delete',
    'knowledge.documents.list', 'knowledge.documents', 'knowledge.documents.get',
    'knowledge.documents.delete', 'knowledge.documents.chunks', 'knowledge.search']) {
    assert.ok(ids.includes(m2), '路由表缺少 ' + m2);
  }
  for (const m1 of ['identity.setup.status', 'identity.login', 'identity.me',
    'identity.users.create', 'identity.credentials', 'identity.apikeys']) {
    assert.ok(ids.includes(m1), '路由表缺少 ' + m1);
  }
  // M3 的治理路由必须真的挂在表里（同 M2 的理由：少挂只表现为 404，难查）
  for (const m3 of ['governance.audit', 'governance.audit.verify', 'governance.quotas',
    'governance.quotas.upsert', 'governance.quotas.remove', 'governance.usage']) {
    assert.ok(ids.includes(m3), '路由表缺少 ' + m3);
  }
  // M4 的能力分发路由必须真的挂在表里（同 M2/M3 的理由）
  //
  // ⚠️ 0.21.10：`capability.tools.enabled` 已随"工具作为可治理能力"整块删除，
  //    所以它从这个清单里**去掉**了 —— 改断言而不是改代码，因为消失的是**概念**。
  //    但"删掉一个路由"和"改名/漏挂"在路由表里长得一样，所以下面补一条**反向断言**
  //    把"它真的没了"钉住（见 0.21.6/0.21.7 同款做法）。
  for (const m4 of ['capability.skills', 'capability.skills.install', 'capability.skills.enabled',
    'capability.skills.checkUpdate', 'capability.mcp', 'capability.mcp.upsert', 'capability.mcp.probe',
    'capability.policies', 'capability.bindings.set', 'capability.bindings.remove',
    'governance.artifacts', 'governance.sessions.log']) {
    assert.ok(ids.includes(m4), '路由表缺少 ' + m4);
  }
  // 反向断言：工具登记表的启停路由不许回来（0.21.10 用户裁定"工具不是可治理的能力"）
  assert.ok(!ids.includes('capability.tools.enabled'),
    'capability.tools.enabled 不该在路由表里 —— 工具已不是可治理能力（0.21.10），'
    + '把它加回来等于把删掉的 concepts 又养回来');
  assert.ok(!ids.some((x) => /^capability\.tools(\.|$)/.test(x)),
    '路由表里不许有任何 capability.tools.* 路由');
  // 0.18.0 的 Skill 卸载路由（同理由；单独列出以示它不属于 M4 批次）
  assert.ok(ids.includes('capability.skills.remove'), '路由表缺少 capability.skills.remove');
  // 0.18.0 的文档改名路由（E2；同理由：单独列出以示它不属于 M2 批次）
  assert.ok(ids.includes('knowledge.documents.update'), '路由表缺少 knowledge.documents.update');
  // 0.18.0 的备份删除路由（E3）：除了"挂上了"，还要断言声明面 ——
  // 方法/档位/权限键写错时路由仍在表里，但语义已经错了，只查 id 查不出来。
  const rm = r.body.routes.find((x) => x.id === 'operation.backup.remove');
  assert.ok(rm, '路由表缺少 operation.backup.remove');
  assert.equal(rm.method, 'DELETE');
  assert.equal(rm.path, '/api/operation/backup/:file');
  assert.equal(rm.scope, 'admin');
  assert.deepEqual(rm.capability, ['operation:delete']);
});

/* ── 12. 用户组（组级角色绑定） ─────────────────────────────────────── */
// 为什么放在最后：本段会**故意制造一次 403**（只读账号试图建组）。
// 上面的审计断言要求"所有 access.denied 都属于同一个人（viewer）"——
// 若把本段插在审计之前，就会给审计里多塞一条别人的 denied，让断言假性失败。
// 这正说明"组"不是纯新增：它改变了"谁算管理员"，也改变了审计里能看到的东西。

section('用户组：组级角色经 HTTP 认证路径真正生效');

await t('路由表登记了用户组的 7 条接口（少挂只表现为 404，比启动失败更难查）', async () => {
  const r = await call('GET', '/api/system/routes');
  assert.equal(r.status, 200);
  const ids = r.body.routes.map((x) => x.id);
  for (const id of ['identity.groups', 'identity.groups.create', 'identity.groups.detail',
    'identity.groups.update', 'identity.groups.delete', 'identity.groups.roles', 'identity.groups.members']) {
    assert.ok(ids.includes(id), '路由表缺少 ' + id);
  }
});

await t('组级角色全链路生效：建组→授角色→加成员→成员 /me 出现角色→删组即失效', async () => {
  // ① 建一个只读测试账号，并把**直接绑定摘空** —— 好证明后面看到的角色确实来自组
  const cu = await call('POST', '/api/identity/users', {
    token: adminToken,
    json: { username: 'groupbot', password: 'Gr0up-Bot!23', displayName: '组测试账号' },
  });
  assert.equal(cu.status, 201, cu.text.slice(0, 200));
  const botId = cu.body.user.id;

  // 建用户时不传 roles 会默认成 member（服务端默认档），这里显式摘空，
  // 让"唯一角色来源是组"这个前提成立。
  const strip = await call('PUT', '/api/identity/users/' + botId + '/roles', {
    token: adminToken, json: { roles: [] },
  });
  assert.equal(strip.status, 200, strip.text.slice(0, 200));
  assert.deepEqual(strip.body.user.roles, [], '直接绑定应被摘空');

  const botLogin = await call('POST', '/api/identity/login', {
    json: { username: 'groupbot', password: 'Gr0up-Bot!23' },
  });
  assert.equal(botLogin.status, 200, botLogin.text.slice(0, 200));
  const botToken = botLogin.body.token;
  assert.deepEqual(botLogin.body.user.roles, [], '直接绑定为空 → 登录时生效角色也应为空');

  // ② 建组并授 viewer 角色
  const g = await call('POST', '/api/identity/groups', {
    token: adminToken, json: { name: '验收组', description: 'HTTP 端到端：组级绑定' },
  });
  assert.equal(g.status, 201, g.text.slice(0, 200));
  const gid = g.body.group.id;
  assert.equal(g.body.group.name, '验收组');
  assert.deepEqual(g.body.group.roles, [], '新组默认不带角色');
  assert.deepEqual(g.body.group.members, []);

  const gr = await call('PUT', '/api/identity/groups/' + gid + '/roles', {
    token: adminToken, json: { roles: ['viewer'] },
  });
  assert.equal(gr.status, 200, gr.text.slice(0, 200));
  assert.deepEqual(gr.body.group.roles, ['viewer']);

  // ③ 把只读账号加进组（此刻他的直接绑定仍为空）
  const gm = await call('PUT', '/api/identity/groups/' + gid + '/members', {
    token: adminToken, json: { userIds: [botId] },
  });
  assert.equal(gm.status, 200, gm.text.slice(0, 200));
  assert.deepEqual(gm.body.group.members.map((m) => m.userId), [botId]);

  // ★ 核心断言：角色的唯一来源是这个组，必须经**认证路径**带进 /me
  const me = await call('GET', '/api/identity/me', { token: botToken });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.user.roles, ['viewer'], '组级 viewer 必须出现在生效角色里');
  assert.ok(me.body.user.groups.some((x) => x.id === gid), '应带出所属组');
  assert.equal(me.body.permissions.user.read, true, '组带来的角色要能真的过 RBAC');
  assert.equal(me.body.permissions.session.execute, false, 'viewer 仍是只读，没有被放大');

  // ④ 同一个令牌打只读接口应当放行（否则"角色生效"只停留在 /me 的好看字段里）
  const allowed = await call('GET', '/api/identity/users', { token: botToken });
  assert.equal(allowed.status, 200, '组级 viewer 应能读用户列表，实际 ' + allowed.status);

  // ⑤ 组只给了 viewer、没给 group:write → 不能建组，且拒绝要说清缺什么
  const denied = await call('POST', '/api/identity/groups', {
    token: botToken, json: { name: '越权组' },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'forbidden');
  assert.deepEqual(denied.body.error.detail.needs, ['group:write'], '403 要说明缺哪条能力');

  // ⑥ 删组 → 组级角色随之消失（组绑定是"活的"，不是复制一份快照）
  const del = await call('DELETE', '/api/identity/groups/' + gid, { token: adminToken });
  assert.equal(del.status, 200, del.text.slice(0, 200));
  const gone = await call('GET', '/api/identity/me', { token: botToken });
  assert.deepEqual(gone.body.user.roles, [], '删组后组级角色必须消失');
  assert.deepEqual(gone.body.user.groups, [], '删组后所属组列表也要清空');
  const again = await call('GET', '/api/identity/users', { token: botToken });
  assert.equal(again.status, 403, '角色随组消失后，只读接口必须重新拒绝');
});

await t('组列表与详情：只读可见、成员计数如实、未知组 404', async () => {
  const g = await call('POST', '/api/identity/groups', {
    token: adminToken, json: { name: '归档组' },
  });
  assert.equal(g.status, 201, g.text.slice(0, 200));
  const gid = g.body.group.id;

  const list = await call('GET', '/api/identity/groups', { token: adminToken });
  assert.equal(list.status, 200);
  const hit = list.body.groups.find((x) => x.id === gid);
  assert.ok(hit, '新建的组应出现在列表里');
  assert.equal(hit.name, '归档组');
  assert.equal(hit.memberCount, 0, '新组没有成员');

  const detail = await call('GET', '/api/identity/groups/' + gid, { token: adminToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.group.id, gid);
  assert.deepEqual(detail.body.group.roles, []);
  assert.deepEqual(detail.body.group.members, []);

  const missing = await call('GET', '/api/identity/groups/g_nope', { token: adminToken });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');

  const del = await call('DELETE', '/api/identity/groups/' + gid, { token: adminToken });
  assert.equal(del.status, 200);
  const after = await call('GET', '/api/identity/groups/' + gid, { token: adminToken });
  assert.equal(after.status, 404, '删掉的组再查应 404');
});

/* ── 部门（B8）：组织归属，不是权限载体 ───────────────────────────── */

section('部门：有创建/列出的出口，且如实声明它不参与权限判定');

await t('部门列表：可读，且响应里如实说明"不是权限载体"', async () => {
  const r = await call('GET', '/api/identity/departments', { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.departments), 'departments 必须是数组');
  // 这句说明不是装饰：界面与接口都必须挡住"把人挪进某部门 = 给权限"这个误解。
  assert.ok(/不参与权限判定/.test(r.body.note || ''), '响应里必须说清部门不参与权限判定');
  // 出口补齐后，note 同时要预告"有引用的部门删不掉"——先说清楚，再给出人话拒绝。
  assert.ok(/拒绝删除/.test(r.body.note || ''), 'note 要预告有引用的部门会被拒绝删除，实际：' + r.body.note);
});

await t('部门：能创建（201 且成员数为 0）、重名 409、空名 400', async () => {
  const name = 'HTTP 回归部门';
  const c = await call('POST', '/api/identity/departments', { token: adminToken, json: { name } });
  assert.equal(c.status, 201, '创建部门应 201，实际 ' + c.status + ' ' + c.text.slice(0, 160));
  assert.ok(c.body.department.id);
  assert.equal(c.body.department.memberCount, 0, '新建部门的成员数是 0（数字），与列表同形状');

  const dup = await call('POST', '/api/identity/departments', { token: adminToken, json: { name } });
  assert.equal(dup.status, 409, '同组织重名必须 409');

  const empty = await call('POST', '/api/identity/departments', { token: adminToken, json: { name: '   ' } });
  assert.equal(empty.status, 400, '空名要 400 —— 不能靠数据库兜底');
});

await t('改归属：PUT 用户资料真的改掉部门、成员数跟着变、非法 id 是 400 而非 500', async () => {
  const list = await call('GET', '/api/identity/departments', { token: adminToken });
  const dept = list.body.departments.find((d) => d.name === 'HTTP 回归部门');
  assert.ok(dept, '上一条用例建的部门应当在这里');

  const users = await call('GET', '/api/identity/users', { token: adminToken });
  const admin = users.body.users.find((u) => u.username === 'admin');
  assert.ok(admin, '找不到 admin 账号');

  const ok = await call('PUT', '/api/identity/users/' + admin.id, { token: adminToken, json: { deptId: dept.id } });
  assert.equal(ok.status, 200, '改归属应 200，实际 ' + ok.status + ' ' + ok.text.slice(0, 160));
  assert.equal(ok.body.user.deptId, dept.id, '归属要真的写进去（响应里能直接看到）');

  const list2 = await call('GET', '/api/identity/departments', { token: adminToken });
  assert.equal(list2.body.departments.find((d) => d.id === dept.id).memberCount, 1, '成员数要跟着变（不是写死的）');

  const bad = await call('PUT', '/api/identity/users/' + admin.id, { token: adminToken, json: { deptId: 'dept_not_exists' } });
  assert.equal(bad.status, 400, '不存在的部门必须 400（不是 500，更不是静默写进去）');

  const clear = await call('PUT', '/api/identity/users/' + admin.id, { token: adminToken, json: { deptId: null } });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.user.deptId, null, 'null 要能清空归属');
});

await t('部门权限分级：只读角色能看不能建（403）', async () => {
  const r = await call('GET', '/api/identity/departments', { token: viewerToken });
  assert.equal(r.status, 200, 'viewer 有 department:read，应当能看，实际 ' + r.status);
  const w = await call('POST', '/api/identity/departments', { token: viewerToken, json: { name: 'viewer 不该建成' } });
  assert.equal(w.status, 403, 'viewer 没有 department:write，必须 403，实际 ' + w.status);
});

await t('部门改名（HTTP）：PATCH 200 且名字真变；改成自己现在的名字 200；空名 400、重名 409、不存在 404', async () => {
  const list = await call('GET', '/api/identity/departments', { token: adminToken });
  const dept = list.body.departments.find((d) => d.name === 'HTTP 回归部门');
  assert.ok(dept, '前面用例建的部门应当在这里');

  const up = await call('PATCH', '/api/identity/departments/' + dept.id, { token: adminToken, json: { name: 'HTTP 回归部门（改名后）' } });
  assert.equal(up.status, 200, '改名应 200，实际 ' + up.status + ' ' + up.text.slice(0, 160));
  assert.equal(up.body.department.name, 'HTTP 回归部门（改名后）', '响应必须带新名字（不是只有 200）');
  assert.equal(typeof up.body.department.childCount, 'number', '改名响应与列表同形状（childCount 是数字）');

  // 改成自己现在的名字不是重名冲突——库里那个"同名"就是它自己（排除自己的判定）。
  const self = await call('PATCH', '/api/identity/departments/' + dept.id, { token: adminToken, json: { name: 'HTTP 回归部门（改名后）' } });
  assert.equal(self.status, 200, '改成自己现在的名字必须放行，实际 ' + self.status + ' ' + self.text.slice(0, 160));

  const other = await call('POST', '/api/identity/departments', { token: adminToken, json: { name: 'HTTP 重名占位' } });
  assert.equal(other.status, 201, other.text.slice(0, 160));
  const clash = await call('PATCH', '/api/identity/departments/' + dept.id, { token: adminToken, json: { name: 'HTTP 重名占位' } });
  assert.equal(clash.status, 409, '与别的部门重名必须 409，实际 ' + clash.status);
  assert.match(clash.body.error.message, /同名部门/, '拒绝理由要是人话：' + JSON.stringify(clash.body));

  const empty = await call('PATCH', '/api/identity/departments/' + dept.id, { token: adminToken, json: { name: '   ' } });
  assert.equal(empty.status, 400, '空名必须 400');
  assert.match(empty.body.error.message, /不能为空/);

  const missing = await call('PATCH', '/api/identity/departments/dept_nope', { token: adminToken, json: { name: 'x' } });
  assert.equal(missing.status, 404, '不存在的部门改名必须 404，实际 ' + missing.status);

  // 被拒的改名不能留半个状态：现名必须仍是上一次成功改成的那个。
  const after = await call('GET', '/api/identity/departments', { token: adminToken });
  assert.equal(after.body.departments.find((d) => d.id === dept.id).name, 'HTTP 回归部门（改名后）', '被拒的改名不应影响现名');
});

await t('部门删除（HTTP）：有成员 / 有子部门都拒（人话理由），引用解除后才删得掉；viewer 一律 403', async () => {
  const p = await call('POST', '/api/identity/departments', { token: adminToken, json: { name: 'HTTP 待删父部门' } });
  const c = await call('POST', '/api/identity/departments', { token: adminToken, json: { name: 'HTTP 待删子部门', parentId: p.body.department.id } });
  assert.equal(p.status, 201, p.text.slice(0, 160));
  assert.equal(c.status, 201, c.text.slice(0, 160));
  assert.equal(c.body.department.parentId, p.body.department.id, '子部门的 parentId 要落库');
  const parentId = p.body.department.id, childId = c.body.department.id;

  // 1) 成员护栏：把 admin 挂到子部门 → 删除必须 409 + 带人数
  const users = await call('GET', '/api/identity/users', { token: adminToken });
  const admin = users.body.users.find((u) => u.username === 'admin');
  assert.ok(admin, '找不到 admin 账号');
  await call('PUT', '/api/identity/users/' + admin.id, { token: adminToken, json: { deptId: childId } });

  const withMember = await call('DELETE', '/api/identity/departments/' + childId, { token: adminToken });
  assert.equal(withMember.status, 409, '有成员的部门必须 409，实际 ' + withMember.status);
  assert.match(withMember.body.error.message, /还有 1 个成员/, '理由要带人数：' + JSON.stringify(withMember.body));

  // 解除成员引用 → 轮到 2) 子部门护栏（对父部门）
  const clear = await call('PUT', '/api/identity/users/' + admin.id, { token: adminToken, json: { deptId: null } });
  assert.equal(clear.status, 200);

  const withChild = await call('DELETE', '/api/identity/departments/' + parentId, { token: adminToken });
  assert.equal(withChild.status, 409, '有子部门的部门必须 409，实际 ' + withChild.status);
  assert.match(withChild.body.error.message, /子部门/, '理由要人话：' + JSON.stringify(withChild.body));

  // 3) 先删子、再删父；删过的再删是 404
  const delChild = await call('DELETE', '/api/identity/departments/' + childId, { token: adminToken });
  assert.equal(delChild.status, 200, '无引用的子部门应能删掉，实际 ' + delChild.status + ' ' + delChild.text.slice(0, 160));
  const delParent = await call('DELETE', '/api/identity/departments/' + parentId, { token: adminToken });
  assert.equal(delParent.status, 200, '子部门处理完父部门应能删掉，实际 ' + delParent.status + ' ' + delParent.text.slice(0, 160));
  const again = await call('DELETE', '/api/identity/departments/' + childId, { token: adminToken });
  assert.equal(again.status, 404, '删过的部门再删是 404（如实说没有）');

  // 4) viewer：读得到列表，但改名 / 删除一律 403（能力是分开声明的）
  const list = await call('GET', '/api/identity/departments', { token: adminToken });
  const survivor = list.body.departments.find((d) => d.name === 'HTTP 重名占位');
  assert.ok(survivor, '改名用例建的占位部门应当还在');
  const vp = await call('PATCH', '/api/identity/departments/' + survivor.id, { token: viewerToken, json: { name: 'viewer 不该改' } });
  assert.equal(vp.status, 403, 'viewer 没有 department:write，改名必须 403，实际 ' + vp.status);
  const vd = await call('DELETE', '/api/identity/departments/' + survivor.id, { token: viewerToken });
  assert.equal(vd.status, 403, 'viewer 没有 department:delete，删除必须 403，实际 ' + vd.status);

  // 清场（与「移出组」同一条纪律：别把临时数据留给后面的审计/统计）。
  await call('DELETE', '/api/identity/departments/' + survivor.id, { token: adminToken });
  const renamed = list.body.departments.find((d) => d.name === 'HTTP 回归部门（改名后）');
  if (renamed) await call('DELETE', '/api/identity/departments/' + renamed.id, { token: adminToken });
});

/* ── 出口补齐（A2-(b)）：删除用户 / 移出组 ─────────────────────────── */

section('出口补齐：删除用户 / 移出组');

await t('删除用户（HTTP）：真删并连带清理；自删 409；不存在 404', async () => {
  const me = await call('GET', '/api/identity/me', { token: adminToken });
  const selfId = me.body.user.id;

  const cu = await call('POST', '/api/identity/users', {
    token: adminToken, json: { username: 'http_del_1', password: 'Http-Del!2345', roles: ['member'] },
  });
  assert.equal(cu.status, 201, '前置：建用户应 201：' + cu.text.slice(0, 160));
  const uid = cu.body.user.id;

  // 守卫：不能删自己（409 —— 会把自己锁在外面）
  const selfDel = await call('DELETE', '/api/identity/users/' + selfId, { token: adminToken });
  assert.equal(selfDel.status, 409, '自删应 409：' + selfDel.text.slice(0, 160));

  // 不存在的 id → 404
  const nf = await call('DELETE', '/api/identity/users/usr_nope', { token: adminToken });
  assert.equal(nf.status, 404);

  // 真删：连带清掉绑定（这个用户建时带 member 角色，正好 1 条）
  const del = await call('DELETE', '/api/identity/users/' + uid, { token: adminToken });
  assert.equal(del.status, 200, del.text.slice(0, 160));
  assert.equal(del.body.removed.roleBindings, 1, '角色绑定要一起清');
  const list = await call('GET', '/api/identity/users', { token: adminToken });
  assert.ok(!list.body.users.some((u) => u.id === uid), '删除后不该还在用户列表里');
});

await t('移出组（HTTP）：定点移除，另一个成员不受影响', async () => {
  const cu1 = await call('POST', '/api/identity/users', { token: adminToken, json: { username: 'http_gm_1', password: 'Http-Gm!23456', roles: ['member'] } });
  const cu2 = await call('POST', '/api/identity/users', { token: adminToken, json: { username: 'http_gm_2', password: 'Http-Gm!23456', roles: ['member'] } });
  assert.equal(cu1.status, 201, cu1.text.slice(0, 160));
  assert.equal(cu2.status, 201, cu2.text.slice(0, 160));

  const g = await call('POST', '/api/identity/groups', { token: adminToken, json: { name: 'HTTP 临时组' } });
  assert.equal(g.status, 201, g.text.slice(0, 160));
  const gid = g.body.group.id;

  const set = await call('PUT', '/api/identity/groups/' + gid + '/members', { token: adminToken, json: { userIds: [cu1.body.user.id, cu2.body.user.id] } });
  assert.equal(set.status, 200, set.text.slice(0, 160));
  assert.equal(set.body.group.members.length, 2);

  const rm = await call('DELETE', '/api/identity/groups/' + gid + '/members/' + cu1.body.user.id, { token: adminToken });
  assert.equal(rm.status, 200, rm.text.slice(0, 160));
  assert.deepEqual(rm.body.group.members.map((m) => m.userId), [cu2.body.user.id], '另一个成员必须原样保留');
  const again = await call('DELETE', '/api/identity/groups/' + gid + '/members/' + cu1.body.user.id, { token: adminToken });
  assert.equal(again.status, 404, '已不在组里 → 404，如实说"没有这个人"');

  // 清场：别把临时数据留给后面的审计/统计
  await call('DELETE', '/api/identity/groups/' + gid, { token: adminToken });
  await call('DELETE', '/api/identity/users/' + cu1.body.user.id, { token: adminToken });
  await call('DELETE', '/api/identity/users/' + cu2.body.user.id, { token: adminToken });
});

/* ── 出口补齐（0.17.0）：CSV 批量导入 ───────────────────────────────
 *
 * 放在这里的原因与用户组/模型中心同源：本段会**故意制造一次 403**
 * （只读账号导入），并往审计里写一批 `identity.user.create`（via=import）——
 * 而上面的审计断言对"动作集合"与 denied 归属做了全局核对，
 * 插在它之前会打乱那些断言。
 */

section('CSV 批量导入：逐行独立、报表带行号');

await t('导入（HTTP）：好行真建、坏行只跳过自己、报表逐行给行号与原因', async () => {
  const csv = [
    'username,password,displayName,dept,roles',
    'http_imp_a,Imp-Aa!2345,导入甲,,member',
    'http_imp_b,Imp-Bb!2345,导入乙,,member;viewer',
    ',Imp-Cc!2345,无账号行,,',
    'http_imp_d,short,弱口令行,,',
    'admin,Imp-Ee!2345,与管理员重名,,',
  ].join('\n') + '\n';

  const r = await call('POST', '/api/identity/users/import', { token: adminToken, json: { csv } });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const rep = r.body.report;
  assert.equal(rep.total, 5, '数据行 5 行（表头不算），实际 ' + rep.total);
  assert.equal(rep.created, 2);
  assert.equal(rep.failed, 3);
  assert.equal(rep.rows.length, 5);

  // 行号是**文件里的物理行**（表头是第 1 行）—— 用户拿着报表要能直接定位回 Excel 那一行。
  // 第 3 行那个带分号的 roles 列同时也是"多个角色按分隔符解析"的钉子。
  assert.deepEqual(rep.rows.map((x) => x.line), [2, 3, 4, 5, 6]);
  const okRows = rep.rows.filter((x) => x.ok);
  assert.deepEqual(okRows.map((x) => x.username), ['http_imp_a', 'http_imp_b']);
  assert.ok(okRows.every((x) => typeof x.id === 'string' && x.id), '成功行要带 id，供逐条对账');
  const badRows = rep.rows.filter((x) => !x.ok);
  assert.match(badRows[0].error, /账号为空/);
  assert.match(badRows[1].error, /口令不符合要求/);
  assert.match(badRows[2].error, /已存在/);

  // "报表说成功"与"账号真能用"是两件事：好行必须能按 CSV 里的原口令登录。
  // roles 列写的是 member;viewer —— 半角分隔符解析后必须真的生效。
  const lg = await call('POST', '/api/identity/login', { json: { username: 'http_imp_b', password: 'Imp-Bb!2345' } });
  assert.equal(lg.status, 200, '导入的账号必须能按原口令登录：' + lg.text.slice(0, 200));
  assert.deepEqual(lg.body.user.roles.sort(), ['member', 'viewer'], 'roles 列解析结果要真的进身份');
});

await t('导入重跑安全：已创建的行按「已存在」逐行拒绝，不重复创建', async () => {
  const csv = 'username,password\nhttp_imp_a,Imp-Aa!2345\nhttp_imp_b,Imp-Bb!2345\n';
  const before = await call('GET', '/api/identity/users', { token: adminToken });
  const r = await call('POST', '/api/identity/users/import', { token: adminToken, json: { csv } });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.body.report.created, 0, '重跑不得重复创建');
  assert.equal(r.body.report.failed, 2);
  assert.ok(r.body.report.rows.every((x) => /已存在/.test(x.error)));
  const after = await call('GET', '/api/identity/users', { token: adminToken });
  assert.equal(after.body.total, before.body.total, '账号总数不得变');
});

await t('导入（HTTP）：表头 / 引号 / 上限问题一律 400 且是人话，不是 500', async () => {
  const cases = [
    ['未闭合引号', 'username,password\n"never-closed,pw\n', /引号没有闭合/],
    ['未知列', 'username,password,备注\na,Pw-Aa!2345,x\n', /无法识别的列/],
    ['缺口令列', 'username,displayName\na,甲\n', /缺少「口令」列/],
    ['只有表头', 'username,password\n', /只有表头/],
    ['空内容', '\n\n', /没有内容/],
    ['超长', 'x'.repeat(512 * 1024 + 1), /长度不能超过/],
  ];
  for (const [label, csv, re] of cases) {
    const r = await call('POST', '/api/identity/users/import', { token: adminToken, json: { csv } });
    assert.equal(r.status, 400, label + '：应 400，实际 ' + r.status + '：' + r.text.slice(0, 200));
    // 形状校验（requireBody）的回是「入参校验失败」+ detail.fields 逐字段原因；
    // service 层的 badRequest 则把原因写在 message 里 —— 两处都要看到才算"人话"。
    const msg = r.body.error.message + ' ' + JSON.stringify(r.body.error.detail || {});
    assert.ok(re.test(msg), label + '：状态 ' + r.status + ' 响应 ' + r.text.slice(0, 300));
  }

  // 512KB（上限恰好内）的文本在 JSON 里换行会翻倍 ≈1MB —— 必须活着走到业务校验。
  // 这条钉住路由"显式放宽到 2MB"：改回默认 256KB 时这里会变成 413。
  const big = await call('POST', '/api/identity/users/import', { token: adminToken, json: { csv: '\n'.repeat(512 * 1024) } });
  assert.equal(big.status, 400, '上限内的大文件应走到业务校验（400 没有内容），而不是被 413 掐断：' + big.text.slice(0, 200));
});

await t('导入（HTTP）：只读账号 403（user:write），且不产生任何副作用', async () => {
  const before = await call('GET', '/api/identity/users', { token: adminToken });
  const r = await call('POST', '/api/identity/users/import', {
    token: viewerToken,
    json: { csv: 'username,password\nhttp_imp_evil,Evil-Aa!2345\n' },
  });
  assert.equal(r.status, 403, 'viewer 导入应被拒，实际 ' + r.status);
  assert.deepEqual(r.body.error.detail.needs, ['user:write']);
  const after = await call('GET', '/api/identity/users', { token: adminToken });
  assert.equal(after.body.total, before.body.total, '被拒的导入不得建出任何账号');
});

await t('导入留审计：汇总一行 + 每个成功账号逐条 user.create（带 via=import 与行号）', async () => {
  const org = audit.list(orgId, { limit: 800 });
  const summary = org.filter((x) => x.action === 'identity.users.import');
  assert.ok(summary.length >= 1, '导入必须留汇总审计');
  const s = JSON.parse(summary[summary.length - 1].detail_json);
  assert.deepEqual([s.total, s.created, s.failed], [5, 2, 3], '汇总要如实写清总数/成功/失败');

  const perRow = org.filter((x) => x.action === 'identity.user.create' && JSON.parse(x.detail_json).via === 'import');
  assert.equal(perRow.length, 2, '两个成功行应各留一条 user.create（实际 ' + perRow.length + '）—— 导入不是黑箱批量');
  const lines = perRow.map((x) => JSON.parse(x.detail_json).line).sort((a, b) => a - b);
  assert.deepEqual(lines, [2, 3], '明细要带 CSV 行号，方便与文件对账');
  assert.ok(perRow.every((x) => /^usr_/.test(x.resource_id)), 'resourceId 要指向真被建出来的账号');
});

/* ── 模型中心（P1-1）────────────────────────────────────────────────
 *
 * 放在文件最末一段，理由与上面的用户组段相同：这里会**故意制造 403**
 * （只读账号试图登记模型 / 触发探活），而上游的审计断言要求
 * "所有 access.denied 都属于同一个人"。插在审计之前会给它多塞一条别人的
 * denied，让断言假性失败 —— 这不是测试顺序的偏好，而是"新增接口改变了审计里
 * 能看到的东西"这一事实的体现。
 */
section('模型中心：登记 / 默认与降级链 / 探活两层结论 / 越权');

await t('登记模型条目：201；形状里只出凭据名、不出凭据值；校验失败是 400 不是 500', async () => {
  const c = await call('POST', '/api/model/providers', {
    token: adminToken,
    json: {
      name: 'http-对话', kind: 'chat', protocol: 'anthropic-messages',
      baseUrl: 'http://127.0.0.1:1', model: 'http-chat', priority: 10, credentialName: 'chat-cred',
    },
  });
  assert.equal(c.status, 201, c.text.slice(0, 300));
  assert.equal(c.body.provider.name, 'http-对话');
  assert.equal(c.body.provider.endpoint, 'http://127.0.0.1:1/v1/messages', '要把真实端点算出来给运维看');
  assert.equal(c.body.provider.credentialName, 'chat-cred', '凭据**名**可以出（运维要认得出用的哪条）');
  assert.ok(!('credentialValue' in c.body.provider) && !('apiKey' in c.body.provider),
    '响应形状里不允许有承载"值"的字段');
  const id = c.body.provider.id;

  const l = await call('GET', '/api/model/providers', { token: adminToken });
  assert.equal(l.status, 200);
  assert.ok(l.body.providers.some((x) => x.id === id), '新建条目应出现在列表');
  assert.ok(l.body.chain && l.body.chain.chat, '列表要一并带回默认与链（省掉前端第二次请求）');
  assert.ok(/不做请求转发/.test(l.body.status.boundaries), '边界说明必须随状态一起返回给前端');

  const bad = await call('POST', '/api/model/providers', {
    token: adminToken, json: { name: 'bad-proto', kind: 'chat', protocol: 'ollama' },
  });
  assert.equal(bad.status, 400, '用途与协议不匹配应是 400');
  assert.equal(bad.body.error.code, 'bad_request');

  const dup = await call('POST', '/api/model/providers', {
    token: adminToken, json: { name: 'http-对话', kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://h', model: 'm' },
  });
  assert.equal(dup.status, 400, '同名要 400');
});

await t('设为默认 / 启停 / 删除走 HTTP：默认唯一，停用默认项如实回报"已撤掉"', async () => {
  const a = await call('POST', '/api/model/providers', {
    token: adminToken, json: { name: 'http-embed-a', kind: 'embedding', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'ea', priority: 10 },
  });
  const b = await call('POST', '/api/model/providers', {
    token: adminToken, json: { name: 'http-embed-b', kind: 'embedding', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'eb', priority: 20 },
  });
  assert.equal(a.status, 201, a.text.slice(0, 200));
  assert.equal(b.status, 201, b.text.slice(0, 200));

  const s1 = await call('POST', '/api/model/providers/' + a.body.provider.id + '/default', { token: adminToken });
  assert.equal(s1.status, 200);
  assert.equal(s1.body.provider.isDefault, true);
  const s2 = await call('POST', '/api/model/providers/' + b.body.provider.id + '/default', { token: adminToken });
  assert.equal(s2.status, 200);

  const chain = await call('GET', '/api/model/chain', { token: adminToken });
  assert.equal(chain.status, 200);
  assert.equal(chain.body.embedding.defaultSource, 'explicit');
  assert.equal(chain.body.embedding.default.name, 'http-embed-b', '设默认要真的换人（同用途只能有一个）');
  assert.equal(chain.body.embedding.chain.length, 2, '链里应是两条启用项');

  // 停用默认项：默认被撤掉，而且**必须回报**（否则"关一下再开一下"会静默换默认）
  const off = await call('POST', '/api/model/providers/' + b.body.provider.id + '/enabled',
    { token: adminToken, json: { enabled: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.clearedDefault, true, '停用默认项必须显式回报"默认被撤掉了"');
  assert.ok(/重新启用不会自动恢复/.test(off.body.note || ''), '要说清这是单向的：' + off.body.note);

  const d2 = await call('POST', '/api/model/providers/' + b.body.provider.id + '/default', { token: adminToken });
  assert.equal(d2.status, 400, '停用项不能设为默认');

  const del = await call('DELETE', '/api/model/providers/' + b.body.provider.id, { token: adminToken });
  assert.equal(del.status, 200, del.text.slice(0, 200));
  const gone = await call('GET', '/api/model/providers/' + b.body.provider.id, { token: adminToken });
  assert.equal(gone.status, 404, '删掉的条目再查应 404');
});

await t('探活：条目不存在是 404，"连不上"是 200 + 结论（两层不合并）', async () => {
  const missing = await call('POST', '/api/model/providers/mdl_nope/probe', { token: adminToken });
  assert.equal(missing.status, 404, '条目不存在 → 404');
  assert.equal(missing.body.error.code, 'not_found');

  const c = await call('POST', '/api/model/providers', {
    token: adminToken, json: { name: 'http-probe-bad', kind: 'embedding', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'p' },
  });
  const p = await call('POST', '/api/model/providers/' + c.body.provider.id + '/probe', { token: adminToken });
  assert.equal(p.status, 200, '条目存在 → 200；"连不上"是结论，不用状态码表达');
  assert.equal(p.body.verdict.level, 'fail');
  assert.ok(/unreachable/.test(p.body.verdict.code || ''), '失败原因必须分类到"不可达"：' + p.body.verdict.code);
  assert.equal(p.body.verdict.billedRequest, false, '连不上就没产生用量，不能标 true');

  const n = await call('POST', '/api/model/providers', {
    token: adminToken, json: { name: 'http-probe-none', kind: 'embedding', protocol: 'none' },
  });
  assert.equal(n.status, 201, '「不配向量」是合法配置（不需要 baseUrl/model）');
  const pn = await call('POST', '/api/model/providers/' + n.body.provider.id + '/probe', { token: adminToken });
  assert.equal(pn.status, 200);
  assert.equal(pn.body.verdict.level, 'skipped', '"不配向量"必须是 skipped，不能混成 fail');
  assert.equal(pn.body.verdict.ok, true, '跳过不是失败');
});

await t('越权：只读账号登记 / 探活 → 403 且说清缺 model:write；读清单放行', async () => {
  const r = await call('POST', '/api/model/providers', {
    token: viewerToken, json: { name: 'nope', kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://h', model: 'm' },
  });
  assert.equal(r.status, 403, 'viewer 登记模型应被拒，实际 ' + r.status);
  assert.equal(r.body.error.code, 'forbidden');
  assert.deepEqual(r.body.error.detail.needs, ['model:write']);

  const l = await call('GET', '/api/model/providers', { token: viewerToken });
  assert.equal(l.status, 200, '只读角色应能看模型清单（model:read 对四个内置角色都开放）');

  const anyId = l.body.providers[0] && l.body.providers[0].id;
  assert.ok(anyId, '前置：列表里应已有条目');
  const probe = await call('POST', '/api/model/providers/' + anyId + '/probe', { token: viewerToken });
  assert.equal(probe.status, 403, '探活会出网并产生用量，属写动作：viewer 必须被拒');
  assert.deepEqual(probe.body.error.detail.needs, ['model:write']);
});

/* ── 定时任务 / 出站通知 / 指标（P1-2）──────────────────────────────
 *
 * 与模型中心段同样的理由放在最末：这里同样会制造 403（viewer 对 schedule/notify
 * 连读都没有），插在审计断言之前会往 `access.denied` 里多塞一条别人的记录。
 */
section('定时任务 / 通知渠道 / 指标（P1-2）');

await t('调度：非法规则在**写入时**就被拒（400），合法规则算出下次执行时间', async () => {
  // 一套 cron + 时区 + DST 是独立的复杂度来源，本项目只认两种规则。
  // 关键点不是"能拒绝"，而是**在写入时**拒绝 —— 落库一个解析不了的规则，
  // 之后每一轮 tick 都会静默跳过它，那才是最坏的形态。
  const bad = await call('POST', '/api/schedule/jobs', {
    token: adminToken, json: { name: 'http-bad-rule', kind: 'audit.anchor', schedule: 'every 5 minutes' },
  });
  assert.equal(bad.status, 400, bad.text.slice(0, 200));
  assert.equal(bad.body.error.code, 'bad_request');
  assert.ok(/interval|dailyAt/.test(bad.body.error.message), '错误里要直接给出合法写法：' + bad.body.error.message);

  const badKind = await call('POST', '/api/schedule/jobs', {
    token: adminToken, json: { name: 'http-bad-kind', kind: 'rm -rf /', schedule: 'interval:60000' },
  });
  assert.equal(badKind.status, 400, 'kind 是白名单，不接受任意字符串（否则等于把库写入权升级成代码执行）');

  const c = await call('POST', '/api/schedule/jobs', {
    token: adminToken, json: { name: 'http-任务', kind: 'audit.archive', schedule: 'interval:60000' },
  });
  assert.equal(c.status, 201, c.text.slice(0, 200));
  assert.equal(c.body.job.schedule, 'interval:60000');
  assert.ok(c.body.job.nextRunAt, '新建时必须算出下次执行时间，否则任务永远不会到期');
  assert.ok(/每 1 分钟/.test(c.body.job.scheduleText || ''), '要给人话说明：' + c.body.job.scheduleText);

  const dup = await call('POST', '/api/schedule/jobs', {
    token: adminToken, json: { name: 'http-任务', kind: 'audit.anchor', schedule: 'dailyAt:01:00' },
  });
  assert.equal(dup.status, 400, '同名任务应被拒');
  return c.body.job.id;
});

await t('调度：清单带调度器状态与边界说明；改规则重算下次执行', async () => {
  const list = await call('GET', '/api/schedule/jobs', { token: adminToken });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.jobs));
  assert.ok(list.body.jobs.some((j) => j.name === 'http-任务'), '刚建的任务应在清单里');
  assert.ok(list.body.status && 'running' in list.body.status, '清单必须一并带回调度器状态（省掉前端第二次请求）');
  assert.ok(list.body.status.boundaries, '边界说明要随状态一起返回（"进程停了就没有调度"必须写在界面上）');
  assert.ok(/UTC/.test(list.body.status.boundaries), 'dailyAt 按 UTC 解释这件事必须写出来：' + list.body.status.boundaries);

  const job = list.body.jobs.find((j) => j.name === 'http-任务');
  const before = job.nextRunAt;
  const u = await call('PUT', '/api/schedule/jobs/' + job.id, {
    token: adminToken, json: { schedule: 'dailyAt:04:15' },
  });
  assert.equal(u.status, 200, u.text.slice(0, 200));
  assert.equal(u.body.job.schedule, 'dailyAt:04:15');
  assert.notEqual(u.body.job.nextRunAt, before, '规则变了必须重算，否则页面显示的是按旧规则算出来的时间');

  const g404 = await call('PUT', '/api/schedule/jobs/job_nope', { token: adminToken, json: { name: 'x' } });
  assert.equal(g404.status, 404, '不存在的任务 → 404（不是 400，前端要能分辨）');
});

await t('调度：手动执行标 manual，且「没活干」如实记 skipped 而非 fail', async () => {
  const list = await call('GET', '/api/schedule/jobs', { token: adminToken });
  const job = list.body.jobs.find((j) => j.name === 'http-任务');

  const r = await call('POST', '/api/schedule/jobs/' + job.id + '/run', { token: adminToken });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.body.status, 'skipped', '没有超过保留期的记录时应是 skipped：把"没事干"记成失败会让失败计数失去意义');
  assert.equal(r.body.job.lastDetail.manual, true,
    '手动执行必须与定时触发可区分 —— 否则事后没人分得清"这次是自动跑的还是有人点的"');
  assert.ok(Number(r.body.job.runCount) >= 1, 'runCount 要真的 +1');

  const r404 = await call('POST', '/api/schedule/jobs/job_nope/run', { token: adminToken });
  assert.equal(r404.status, 404);
});

await t('调度：tick 手动扫描 —— 未到点的一个都不跑，且不假装跑了', async () => {
  const r = await call('POST', '/api/schedule/tick', { token: adminToken });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.ok(r.body.tick && typeof r.body.tick.due === 'number');
  assert.equal(r.body.tick.due, 0, '刚手动跑过的任务下次执行在 60s 之后，本轮不应有到期任务');
  assert.equal(r.body.tick.ran, 0, '没到期就不能跑 —— 提前跑等于把定时语义做废');
});

await t('调度：越权 —— viewer 对 schedule 连读都没有（清单里没有这个资源）', async () => {
  const l = await call('GET', '/api/schedule/jobs', { token: viewerToken });
  assert.equal(l.status, 403, 'viewer 读调度清单应 403，实际 ' + l.status);
  assert.equal(l.body.error.code, 'forbidden');
  assert.deepEqual(l.body.error.detail.needs, ['schedule:read']);

  const w = await call('POST', '/api/schedule/jobs', {
    token: viewerToken, json: { name: 'nope', kind: 'audit.anchor', schedule: 'interval:60000' },
  });
  assert.equal(w.status, 403);
  assert.deepEqual(w.body.error.detail.needs, ['schedule:write']);

  // run 会真的执行任务体（归档/备份），因此是 write 而不是 read —— 不能被"读权限"顺带放行。
  const list = await call('GET', '/api/schedule/jobs', { token: adminToken });
  const anyId = list.body.jobs[0] && list.body.jobs[0].id;
  const run403 = await call('POST', '/api/schedule/jobs/' + anyId + '/run', { token: viewerToken });
  assert.equal(run403.status, 403, 'run 有副作用，viewer 必须被拒');
  assert.deepEqual(run403.body.error.detail.needs, ['schedule:write']);
});

await t('通知渠道：URL 加密落库，接口只回显 host（URL 里常内嵌机器人 token）', async () => {
  // 非 http(s) 一律拒 —— webhook 只可能是 http(s)，其它 scheme 是 SSRF 载荷的常见伪装。
  const badScheme = await call('POST', '/api/notify/channels', {
    token: adminToken, json: { name: 'ftp', url: 'ftp://10.0.0.9/x', events: ['quota.blocked'] },
  });
  assert.equal(badScheme.status, 400, badScheme.text.slice(0, 200));

  const c = await call('POST', '/api/notify/channels', {
    token: adminToken,
    json: { name: 'http-运维群', url: 'http://10.0.0.9/hook?access_token=HTTP-SUPER-SECRET', events: ['quota.blocked', 'audit.anchor'] },
  });
  assert.equal(c.status, 201, c.text.slice(0, 300));
  assert.equal(c.body.channel.host, 'http://10.0.0.9/…', '只回显 host，够运维认人即可');
  assert.ok(!/HTTP-SUPER-SECRET/.test(c.text), '完整 URL（含 token）绝不能出现在响应里');
  assert.ok(!/access_token/.test(c.text), '连 query 都不能带出来');
  assert.equal(c.body.channel.hasUrl, true);

  const l = await call('GET', '/api/notify/channels', { token: adminToken });
  assert.equal(l.status, 200);
  assert.ok(l.body.channels.some((x) => x.name === 'http-运维群'));
  assert.ok(!/HTTP-SUPER-SECRET/.test(l.text), '清单同样不能回显 token');

  const del = await call('DELETE', '/api/notify/channels/' + c.body.channel.id, { token: adminToken });
  assert.equal(del.status, 200, del.text.slice(0, 200));
});

await t('通知渠道：viewer 无权读写（改渠道等于改密钥的可达范围）', async () => {
  const l = await call('GET', '/api/notify/channels', { token: viewerToken });
  assert.equal(l.status, 403);
  assert.deepEqual(l.body.error.detail.needs, ['notify:read']);

  const w = await call('POST', '/api/notify/channels', {
    token: viewerToken, json: { name: 'nope', url: 'http://10.0.0.9/hook' },
  });
  assert.equal(w.status, 403);
  assert.deepEqual(w.body.error.detail.needs, ['notify:write']);
});

await t('通知重投队列：失败投递落库可见（默认只看 pending），策略与 at-least-once 语义随清单返回', async () => {
  // 为什么必须在 HTTP 层验一遍：队列的**可见性**本身就是接口契约。
  // "后台默默重投"是把"丢了"换成"丢了但没人知道" —— 比不做更糟。这里钉住三件事：
  //   ① 真事件的失败投递会以 pending 出现在清单里；
  //   ② 清单带回重投策略常量（页面要显示"最多重投几次"，不该自己抄一份）；
  //   ③ 投递语义写在**响应里**（而不是只写在文档里，那接收方永远看不到）。
  //
  // 触发路径：建一个订阅 `audit.anchor` 的渠道 → 目标指向**关闭的端口**（回环；
  // 本套回归已显式 `allowLoopback:true`）→ 手动跑一次 audit.anchor 任务 →
  // 投递被拒 → 落队。用"连接被拒"而不是黑洞地址是为了**确定性**：
  // ECONNREFUSED 立刻返回，不必等 8s 超时 ×2 次内联尝试。
  const ch = await call('POST', '/api/notify/channels', {
    token: adminToken,
    json: { name: 'http-队列桩', url: 'http://127.0.0.1:1/hook', events: ['audit.anchor'] },
  });
  assert.equal(ch.status, 201, ch.text.slice(0, 300));

  const job = await call('POST', '/api/schedule/jobs', {
    token: adminToken, json: { name: 'http-锚点', kind: 'audit.anchor', schedule: 'interval:60000' },
  });
  assert.equal(job.status, 201, job.text.slice(0, 300));
  const run = await call('POST', '/api/schedule/jobs/' + job.body.job.id + '/run', { token: adminToken });
  assert.equal(run.status, 200, run.text.slice(0, 300));

  const l = await call('GET', '/api/notify/deliveries', { token: adminToken });
  assert.equal(l.status, 200, l.text.slice(0, 300));
  assert.equal(l.body.status, 'pending', '默认只看待重投的 —— "还欠着的"才是运维要看的那个数');
  assert.ok(l.body.deliveries.length >= 1, '失败的 audit.anchor 投递应落进队列：' + l.text.slice(0, 400));
  const d = l.body.deliveries.find((x) => x.channelName === 'http-队列桩');
  assert.ok(d, '应能按渠道名认出这条：' + JSON.stringify(l.body.deliveries.map((x) => x.channelName)));
  assert.equal(d.event, 'audit.anchor');
  assert.equal(d.attempts, 0,
    'attempts 只记**已被重投**的次数：首次失败时应为 0（内联那 2 次是策略常量，不是记录属性 —— '
    + '写进记录会让 RETRY_MAX 被提前吃掉，页面就与实现对不上了）');
  assert.ok(d.nextRetryAt, '落队时必须算出下次重投时间，否则定时任务永远扫不到它');
  assert.ok(l.body.queue && l.body.queue.pending >= 1, '页面上的"待重投 N 条"就是 queue.pending');
  assert.ok(l.body.policy && l.body.policy.maxAttempts >= 1, '重投上限要随清单给出，页面不自己抄一份');
  assert.ok(/at-least-once/.test(l.body.note || ''), '投递语义必须写在响应里：' + l.body.note);
  assert.ok(/X-STI-Delivery-Id/.test(l.body.note || ''),
    '去重头也得写出来 —— 接收方是唯一清楚"这条处理过没有"的一方，它得知道拿什么去重');

  // 试发**不入队**：那是人在旁边看着的动作，失败会立刻显示给操作者。
  // 把它丢进队列只会让"待处理告警"这个数字被无效测试数据污染。
  const tst = await call('POST', '/api/notify/channels/' + ch.body.channel.id + '/test', { token: adminToken });
  assert.equal(tst.status, 200, tst.text.slice(0, 300));
  assert.equal(tst.body.result.ok, false, '指向关闭端口，试发应当失败');
  const after = await call('GET', '/api/notify/deliveries?status=all', { token: adminToken });
  const testRows = after.body.deliveries.filter((x) => x.channelName === 'http-队列桩' && x.event === 'notify.test');
  assert.equal(testRows.length, 0, '试发失败**不得**入队（否则队列里会混进一堆测试数据）');

  // 手动重投：会真的再 POST 一次（目标仍关闭 → 结论在 result 里，HTTP 仍是 200）。
  // 这个状态码选择是刻意的：合并成一个码就分不出"记录不存在(404)"与"记录在但发不出去(200+结论)"。
  const rd = await call('POST', '/api/notify/deliveries/' + d.id + '/redeliver', { token: adminToken });
  assert.equal(rd.status, 200, rd.text.slice(0, 300));
  assert.equal(rd.body.result.status, 'pending', '投递没成功不是 HTTP 失败：结论在 result 里，状态码仍是 200');
  assert.equal(rd.body.delivery.attempts, 1,
    '手动重投失败也记一次尝试并保持 pending —— 人的明确意志不该被自动上限掐掉');

  const rd404 = await call('POST', '/api/notify/deliveries/ndl_nope/redeliver', { token: adminToken });
  assert.equal(rd404.status, 404, '不存在的投递记录 → 404');

  const del = await call('DELETE', '/api/notify/channels/' + ch.body.channel.id, { token: adminToken });
  assert.equal(del.status, 200, del.text.slice(0, 200));
});

await t('通知重投队列：viewer 无权看清单或重投（清单含投递内容，重投有副作用）', async () => {
  const l = await call('GET', '/api/notify/deliveries', { token: viewerToken });
  assert.equal(l.status, 403);
  assert.deepEqual(l.body.error.detail.needs, ['notify:read']);

  const r = await call('POST', '/api/notify/deliveries/ndl_anything/redeliver', { token: viewerToken });
  assert.equal(r.status, 403, '重投会真的出站 POST，必须 write 而不是 read');
  assert.deepEqual(r.body.error.detail.needs, ['notify:write']);
});

await t('指标：Prometheus 文本、未登录 401、只读账号可读（system:read）', async () => {
  const anon = await call('GET', '/api/system/metrics');
  assert.equal(anon.status, 401, '指标含本组织链长等信息，不是 public');

  const r = await call('GET', '/api/system/metrics', { token: viewerToken });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.match(r.headers.get('content-type') || '', /text\/plain/, '必须是 Prometheus 采集端认的 content-type');
  assert.match(r.headers.get('cache-control') || '', /no-store/, '指标是瞬时值，不能缓存');
  assert.ok(/# TYPE sti_uptime_seconds gauge/.test(r.text), 'TYPE 行必须有：\n' + r.text.slice(0, 300));
  assert.ok(/sti_audit_chain_length\{tenant="/.test(r.text), '链长要按调用方组织给出');
  assert.ok(/sti_http_request_duration_ms_bucket\{route="system.status"/.test(r.text),
    '直方图要按 route 落到桶里（这是"哪条接口慢"的唯一依据）');

  // 指标与审计的口径**刻意不同**：审计只记状态变更，指标每请求都记。
  // 上面那次未登录的 401 也走进过路由链，因此必须被计上 —— 否则 rate 曲线会漏掉全部失败。
  assert.ok(/sti_http_requests_total\{method="GET",route="system.metrics",status="401"\} 1/.test(r.text),
    '401 也是"处理过的一个请求"，必须计数（漏掉失败会让成功率曲线系统性偏好）:\n' + r.text.slice(0, 900));
  // 反过来，**本次**请求不在自己的响应体里：指标是在 handler 之后统一落账的。
  // 这条不是巧合而是设计 —— 写出来是为了防止有人把它挪进 handler（那会让统计口径撕裂）。
  assert.ok(!/route="system.metrics",status="200"/.test(r.text),
    '本次请求自己不该出现在本次输出里（终态统计发生在 handler 之后）');

  const admin = await call('GET', '/api/system/metrics', { token: adminToken });
  assert.equal(admin.status, 200);
  assert.ok(admin.body === null, '指标是纯文本，不是 JSON（parse 失败应留 null 而不是报错）');
  assert.ok(/sti_http_requests_total\{method="GET",route="system\.metrics",status="200"\} 1/.test(admin.text),
    '第二次抓取时，上一次那次 200 就该出现了 —— 这是"每请求都记"的可验证含义:\n'
    + (admin.text.match(/sti_http_requests_total\{[^\n]*/g) || []).slice(0, 8).join('\n'));
});

/* ── OpenAPI 规格（P1-3）──────────────────────────────────────────── */

await t('OpenAPI 规格：从路由表生成、条数对得上、**不套平台信封**、未登录 401', async () => {
  const anon = await call('GET', '/api/system/openapi.json');
  assert.equal(anon.status, 401, '规格含每条接口的权限要求，不是 public');

  const r = await call('GET', '/api/system/openapi.json', { token: viewerToken });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.match(r.headers.get('content-type') || '', /application\/json/);

  // ⚠️ 这是本项目里少数几个刻意**不套** `{ok:true,...}` 信封的接口之一：
  // 套上就不再是合法 OpenAPI，Swagger UI / Postman 全都吃不了。这条断言就是钉住这个决定。
  assert.equal(r.body.ok, undefined, 'OpenAPI 文档必须是标准文档，不能套平台信封');
  assert.equal(r.body.openapi, '3.0.3');
  assert.equal(r.body.info.version, fs.readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim(),
    'info.version 必须来自 VERSION（单点），不是硬编码');

  // **规格不会漂移的实际保障**：条数与真实路由表一致，且每条路由都能在规格里找到自己。
  const total = router.stats().total;
  assert.equal(r.body['x-sti-route-count'], total, '规格必须覆盖全部 ' + total + ' 条路由');
  for (const route of router.list()) {
    const p = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const op = r.body.paths[p] && r.body.paths[p][route.method.toLowerCase()];
    assert.ok(op, '规格里缺 ' + route.method + ' ' + p + '（路由 ' + route.id + '）');
    assert.equal(op.operationId, route.id);
  }

  // 权限模型要机器可读；诚实边界要写在规格自己身上
  assert.deepEqual(r.body.paths['/api/schedule/jobs'].post['x-sti-capability'], ['schedule:write']);
  assert.deepEqual(r.body.paths['/api/health'].get.security, [], 'public 路由要显式声明"不需要认证"');
  assert.ok(/不是逐字段契约/.test(r.body.info.description), '必须写明这份规格不是逐字段契约');
});

/* ── 成本核算（P1-3 · 4.4）────────────────────────────────────────── */

await t('成本：未登录 401、viewer 无权（quota:read 只在管理员），口径说明随数据一起返回', async () => {
  const anon = await call('GET', '/api/governance/cost');
  assert.equal(anon.status, 401, '成本含组织用量推算，不是 public');

  const v = await call('GET', '/api/governance/cost', { token: viewerToken });
  assert.equal(v.status, 403);
  assert.equal(v.body.error.code, 'forbidden');
  assert.deepEqual(v.body.error.detail.needs, ['quota:read']);

  const a = await call('GET', '/api/governance/cost', { token: adminToken });
  assert.equal(a.status, 200, a.text.slice(0, 300));
  assert.ok(a.body.summary && Array.isArray(a.body.summary.items));
  // 还没有任何用量就如实返回空 —— 不能"为了页面好看"编一个 0 元合计出来
  assert.deepEqual(a.body.summary.items, []);
  assert.deepEqual(a.body.summary.totalsByCurrency, {}, '没有已定价用量 → 没有任何币种的合计（不是 CNY 0.00）');
  assert.equal(a.body.summary.unattributed.tokens, 0);

  // 口径必须随数据一起返回：拿这个数去汇报的人得知道它是"估算"而不是账单
  assert.ok(/最小货币单位/.test(a.body.semantics.amount), '要写清金额单位（分/美分，整数）');
  assert.ok(/不追溯/.test(a.body.semantics.pricing), '必须写明"按当前单价估算"');
  assert.ok(/不是 0/.test(a.body.semantics.unpriced), '必须写明"未定价显示为 null，不是 0 元"');
  assert.ok(/不拿默认模型的价去套/.test(a.body.semantics.attribution), '归因规则要写出来');
  assert.ok(/估算/.test(a.body.note || ''), 'note 要直说这是估算、真实计费以供应商结算为准');
});

await t('成本端到端：会话选模型 → 一轮对话 → 按单价算出金额；未归因的用量不摊派', async () => {
  // 单价：输入 1 分/token、输出 2 分/token（即"每 100 万 token 100 万元/200 万元分"，
  // 这样 测试替身 事件里 128/64 个 token 正好给出整数分，便于逐字断言）
  const c = await call('POST', '/api/model/providers', {
    token: adminToken,
    json: {
      name: 'http-成本条目', kind: 'chat', protocol: 'openai-compat',
      baseUrl: 'http://127.0.0.1:1', model: 'cost-http-model',
      currency: 'cny', priceInMinor: 1000000, priceOutMinor: 2000000,
    },
  });
  assert.equal(c.status, 201, c.text.slice(0, 300));
  assert.equal(c.body.provider.currency, 'CNY', '币种入库即归一成大写');
  assert.equal(c.body.provider.priced, true);
  assert.equal(c.body.provider.priceCacheReadMinor, null, '没配的价是 null，不是 0（0 会被读成"缓存免费"）');

  // 写入时即拒：负数 / 小数 / 配了价缺币种 —— 这三种都会让金额算错
  for (const [label, json] of [
    ['负数单价', { currency: 'CNY', priceInMinor: -5 }],
    ['小数单价', { currency: 'CNY', priceInMinor: 1.5 }],
    ['缺币种', { priceInMinor: 100 }],
  ]) {
    const bad = await call('POST', '/api/model/providers', {
      token: adminToken,
      json: { name: 'http-坏价-' + label, kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://h', model: 'm', ...json },
    });
    assert.equal(bad.status, 400, label + ' 必须在写入时就被拒');
    assert.equal(bad.body.error.code, 'bad_request');
  }

  // 建会话时就指定模型 —— 这个选择必须真的落库（否则后续用量无从归因）
  const s = await call('POST', '/api/kernel/sessions', {
    token: adminToken, json: { title: '成本回归会话', model: 'cost-http-model', provider: 'openai-compat' },
  });
  assert.equal(s.status, 201, s.text.slice(0, 200));
  const sid = s.body.session.id;
  assert.equal(s.body.session.modelId, 'cost-http-model', '建会话时的模型选择要如实回报');

  const g = await call('GET', '/api/kernel/sessions/' + sid, { token: adminToken });
  assert.equal(g.body.session.modelId, 'cost-http-model', '会话详情要能回答"这个会话登记的是哪个模型"');

  // 对照：一个**没选模型**的会话。它的用量必须进"未归因"，不许被摊到上面那条头上。
  const s2 = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '未选模型会话' } });
  assert.equal(s2.status, 201, s2.text.slice(0, 200));
  const sid2 = s2.body.session.id;
  assert.equal(s2.body.session.modelId, '', '没选模型就是空串 —— 不偷偷填"注册表里的默认对话模型"');

  const t1 = await call('POST', '/api/kernel/sessions/' + sid + '/turns',
    { token: adminToken, json: { content: '成本口径测试' } });
  assert.equal(t1.status, 200, t1.text.slice(0, 300));
  assert.equal(t1.body.usageCollected.written, 1, '测试替身 每轮产出一条 usage 事件');

  const t2 = await call('POST', '/api/kernel/sessions/' + sid2 + '/turns',
    { token: adminToken, json: { content: '无模型会话' } });
  assert.equal(t2.status, 200, t2.text.slice(0, 300));
  assert.equal(t2.body.usageCollected.written, 1);

  const r = await call('GET', '/api/governance/cost', { token: adminToken });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const item = (r.body.summary.items || []).find((x) => x.modelId === 'cost-http-model');
  assert.ok(item, '要能按模型名归因到刚登记的那条：' + JSON.stringify(r.body.summary.items));

  // 测试替身 固定脚本：input 128 / output 64（reasoning 16 是 output 的子集，不另计）
  // 输入 128 × 1000000 / 1e6 = 128 分；输出 64 × 2000000 / 1e6 = 128 分 → 256 分
  assert.equal(item.tokens.input, 128);
  assert.equal(item.tokens.output, 64);
  assert.equal(item.tokens.reasoning, undefined, 'reasoning 不进成本口径');
  assert.equal(item.amountMinor, 256, '金额必须是 128×1 + 64×2 = 256 分，实际：' + item.amount);
  assert.equal(item.amount, 'CNY 2.56');
  assert.equal(item.provider.name, 'http-成本条目', '要能指出归因到了哪一条（同模型名多条时还必须说明取的是哪条）');
  assert.deepEqual(r.body.summary.totalsByCurrency.CNY, {
    currency: 'CNY', amountMinor: 256, amount: 'CNY 2.56', pricedTokens: 192, unpricedTokens: 0, models: 1,
  });

  // 没选模型的那一轮：token 照数，但**不计入任何金额**
  assert.equal(r.body.summary.unattributed.usageRows, 1);
  assert.equal(r.body.summary.unattributed.tokens, 192, '未归因 = 128 + 64（那一轮的真实用量）');
  assert.equal(r.body.summary.mixedCurrency, false, '只有一个币种时不该标"混合币种"');

  // 改单价必须立刻反映到成本上（金额 = 当下单价 × 历史 token，这是"不追溯"的另一面）
  const up = await call('PUT', '/api/model/providers/' + c.body.provider.id,
    { token: adminToken, json: { priceInMinor: 2000000, priceOutMinor: 2000000 } });
  assert.equal(up.status, 200, up.text.slice(0, 300));
  const r2 = await call('GET', '/api/governance/cost', { token: adminToken });
  const item2 = (r2.body.summary.items || []).find((x) => x.modelId === 'cost-http-model');
  assert.equal(item2.amountMinor, 384, '输入价翻倍后 128×2 + 64×2 = 384 分');

  // 把单价清空 → 回到"未定价"（null），**不是 0**
  const cleared = await call('PUT', '/api/model/providers/' + c.body.provider.id,
    { token: adminToken, json: { currency: '', priceInMinor: '', priceCacheReadMinor: '', priceCacheWriteMinor: '', priceOutMinor: '' } });
  assert.equal(cleared.status, 200, cleared.text.slice(0, 300));
  assert.equal(cleared.body.provider.priced, false);
  assert.equal(cleared.body.provider.priceInMinor, null, '清空后是 null，不是 0');
  const r3 = await call('GET', '/api/governance/cost', { token: adminToken });
  const item3 = (r3.body.summary.items || []).find((x) => x.modelId === 'cost-http-model');
  assert.equal(item3.amountMinor, null, '未定价 → null；写成 0 会被当成"这些调用免费"');
  assert.equal(item3.amount, null);
  assert.deepEqual(r3.body.summary.totalsByCurrency, {}, '没有任何已定价用量 → 不该出现 CNY 0.00 这样的合计');
  assert.ok(/不是 0 元/.test(item3.note || ''), 'note 要把"null ≠ 0"说给看报表的人');
});

await t('成本：用量归因写在 usage_records.model_id 上；改会话模型只影响后续回合', async () => {
  // 上面那条用例结束时把单价清空了，这里重新配上，验证"归因列真的落库"
  const c = await call('POST', '/api/model/providers', {
    token: adminToken,
    json: {
      name: 'http-成本条目2', kind: 'chat', protocol: 'openai-compat',
      baseUrl: 'http://127.0.0.1:1', model: 'cost-http-model-2',
      currency: 'CNY', priceInMinor: 1000000, priceOutMinor: 1000000,
    },
  });
  assert.equal(c.status, 201, c.text.slice(0, 200));

  const s = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '归属切换会话' } });
  const sid = s.body.session.id;

  // 先跑一轮（此时会话还没登记模型 → 这一轮的用量应落到未归因）
  const before = await call('GET', '/api/governance/cost', { token: adminToken });
  const beforeUn = before.body.summary.unattributed.tokens;
  const t0 = await call('POST', '/api/kernel/sessions/' + sid + '/turns', { token: adminToken, json: { content: '切换前' } });
  assert.equal(t0.status, 200);

  // 会话中途选模型
  const m = await call('POST', '/api/kernel/sessions/' + sid + '/model',
    { token: adminToken, json: { provider: 'openai-compat', model: 'cost-http-model-2' } });
  assert.equal(m.status, 200, m.text.slice(0, 300));
  assert.deepEqual(m.body.recorded,
    { modelProvider: 'openai-compat', modelId: 'cost-http-model-2', reasoningEffort: null },
    '响应要回报**落库**的值（不是把我们发出去的值原样回一遍）；0.21.0 起落库值含推理等级');

  const t1 = await call('POST', '/api/kernel/sessions/' + sid + '/turns', { token: adminToken, json: { content: '切换后' } });
  assert.equal(t1.status, 200);

  const after = await call('GET', '/api/governance/cost', { token: adminToken });
  const item = (after.body.summary.items || []).find((x) => x.modelId === 'cost-http-model-2');
  assert.ok(item, '切换后那一轮应归因到新模型名');
  // 一轮 = 128×1 + 64×1 = 192 分
  assert.equal(item.amountMinor, 192, '只有切换后那一轮算进去，切换前那一轮不该被追认：' + item.amount);

  // 切换前那一轮仍留在未归因桶（**不追认**：平台的记录是"那一刻要求上游用什么"，不是事后推断）
  assert.equal(after.body.summary.unattributed.tokens, beforeUn + 192,
    '切换前那一轮（192 token）必须留在未归因桶里，不能被新模型"追认"');
});

/* ── 工作台最后一公里（P1-3 · 3.6）──────────────────────────────────── */

/** 原始字节上传（附件不走 multipart：元数据在 query，body 就是文件） */
async function upload(sid, filename, buf, { token, headers = {} } = {}) {
  const h = { ...headers, 'content-type': 'application/octet-stream' };
  if (token) h.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + '/api/kernel/sessions/' + sid + '/attachments?filename=' + encodeURIComponent(filename),
    { method: 'POST', headers: h, body: buf });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, headers: res.headers, body, text };
}

await t('附件：权限（viewer 不能传）、文本/二进制按**内容**判定、响应不泄漏存储路径', async () => {
  const s = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '附件回归' } });
  assert.equal(s.status, 201, s.text.slice(0, 200));
  const sid = s.body.session.id;

  const anon = await upload(sid, 'a.txt', Buffer.from('x'));
  assert.equal(anon.status, 401, '未登录不能传附件');

  const v = await upload(sid, 'a.txt', Buffer.from('x'), { token: viewerToken });
  assert.equal(v.status, 403, 'viewer 没有 session:write');
  assert.deepEqual(v.body.error.detail.needs, ['session:write'], '403 要说清缺什么权限');

  // 文本附件：能有意义地解码成 UTF-8 → kind=text，可注入
  const txt = await upload(sid, '需求说明.md', Buffer.from('# 需求\n模块 A 要求支持导出。', 'utf8'), { token: adminToken });
  assert.equal(txt.status, 201, txt.text.slice(0, 300));
  assert.equal(txt.body.attachment.kind, 'text');
  assert.equal(txt.body.injectable, true);
  assert.equal(txt.body.attachment.bytes, Buffer.byteLength('# 需求\n模块 A 要求支持导出。', 'utf8'));
  assert.equal(txt.body.attachment.mime, 'application/octet-stream');
  assert.ok(/内容/.test(txt.body.semantics.kind), '要说明 kind 是按内容判的，不是按扩展名');
  // 「发送时会怎样」必须在上传时就一次性说清，而不是等用户发了才发现"怎么没送出去"。
  // 三种互斥结局：image（作为图片块真的送给模型）/ text（正文拼进上下文）/ none（只登记展示）。
  assert.equal(txt.body.delivery.mode, 'text', '文本附件：发送时正文进上下文');
  assert.ok(/拼进本轮上下文/.test(txt.body.delivery.note), '要把"发送时会怎样"说清楚');
  assert.ok(/魔数|内容/.test(txt.body.semantics.mime),
    '要说明 mime 是平台按**文件内容**嗅探的，不是照抄浏览器声明（照抄会让上游整条消息失败）');

  // 二进制附件：名字叫 .txt 也必须判成 binary —— 判定看内容，不看扩展名
  const bin = await upload(sid, 'fake.txt', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]), { token: adminToken });
  assert.equal(bin.status, 201);
  assert.equal(bin.body.attachment.kind, 'binary', '含 NUL 字节 → binary，哪怕扩展名是 .txt');
  assert.equal(bin.body.injectable, false);
  // 通用文件的边界必须直说：字节不到模型。
  assert.equal(bin.body.delivery.mode, 'none', '通用文件发送时不会被交给模型');
  assert.ok(/不会/.test(bin.body.delivery.note), '要把"不会送给模型"直说，不能含糊');

  const list = await call('GET', '/api/kernel/sessions/' + sid + '/attachments', { token: adminToken });
  assert.equal(list.status, 200);
  assert.equal(list.body.count, 2);
  assert.equal(list.text.includes('uploads/'), false, '列表响应里不许出现存储路径（换机器会变死链）');
  assert.equal(/(^|[^a-z])storedPath/.test(list.text), false, '不许输出 storedPath 字段名');
  assert.ok(list.body.limits && list.body.limits.maxBytes > 0, '上限要回给前端（否则用户只知道"失败"不知道为什么）');

  // 缺文件名 / 空文件：都是 400，且信息要能指导用户改
  const noName = await fetch(BASE + '/api/kernel/sessions/' + sid + '/attachments',
    { method: 'POST', headers: { authorization: 'Bearer ' + adminToken }, body: Buffer.from('x') });
  assert.equal(noName.status, 400);
  assert.ok(/filename/.test((await noName.json()).error.message), '报错要点出缺的是 filename');
  const empty = await upload(sid, 'e.txt', Buffer.alloc(0), { token: adminToken });
  assert.equal(empty.status, 400, '空文件应当场拒，而不是存一个 0 字节的"附件"');

  // 下载：内容必须逐字节一致（名字里的中文要走 filename*，不能乱码）
  const dl = await fetch(BASE + '/api/kernel/sessions/' + sid + '/attachments/' + txt.body.attachment.id,
    { headers: { authorization: 'Bearer ' + adminToken } });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), '# 需求\n模块 A 要求支持导出。');
  assert.ok(/filename\*=UTF-8''/.test(dl.headers.get('content-disposition') || ''), '中文文件名要用 RFC 5987');
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');

  // 删除：元数据与落盘字节一起删（只删元数据是"假删除"）
  const del = await call('DELETE', '/api/kernel/sessions/' + sid + '/attachments/' + bin.body.attachment.id, { token: adminToken });
  assert.equal(del.status, 200);
  assert.equal(del.body.bytesDeleted, true, '落盘字节要被真删掉');
  const gone = await fetch(BASE + '/api/kernel/sessions/' + sid + '/attachments/' + bin.body.attachment.id,
    { headers: { authorization: 'Bearer ' + adminToken } });
  assert.equal(gone.status, 404, '删掉之后下载必须是 404，不能还能拿到');
  const list2 = await call('GET', '/api/kernel/sessions/' + sid + '/attachments', { token: adminToken });
  assert.equal(list2.body.count, 1);
});

await t('附件注入端到端：文本进 content 的引用块；二进制不注入且**如实点名**', async () => {
  const s = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '注入回归' } });
  const sid = s.body.session.id;

  const marker = 'PI-31415926';
  const txt = await upload(sid, '规格.txt', Buffer.from('关键常量是 ' + marker + '。', 'utf8'), { token: adminToken });
  const bin = await upload(sid, '图.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), { token: adminToken });
  const t1 = txt.body.attachment.id;
  const b1 = bin.body.attachment.id;

  const r = await call('POST', '/api/kernel/sessions/' + sid + '/turns', {
    token: adminToken,
    json: { content: '请阅读附件', attachmentIds: [t1, b1, 'att_not_exist'] },
  });
  assert.equal(r.status, 200, r.text.slice(0, 400));
  assert.equal(r.body.attachments.requested, 3);
  assert.deepEqual(r.body.attachments.injected.map((x) => x.id), [t1], '只有文本附件被注入');
  const skippedIds = r.body.attachments.skipped.map((x) => x.id);
  assert.deepEqual(skippedIds, [b1], '二进制附件必须出现在 skipped 里（不静默丢弃）');
  assert.equal(r.body.attachments.skipped[0].reason, 'binary');
  assert.deepEqual(r.body.attachments.missing, ['att_not_exist'], '不存在的附件 id 要如实回报"没找到"');

  // 落库的 turn-start 文本 = 真正发给内核的东西（轨迹必须等于事实）
  const start = (r.body.events || []).find((e) => e.type === 'turn-start');
  assert.ok(start, '回合起点事件必须落库');
  assert.ok(start.text.startsWith('请阅读附件'), '用户原始输入在最前面（前端靠这个切分）');
  assert.ok(start.text.includes('<<<STI-ATTACHMENTS>>>'), '注入段要有可分界的标记');
  assert.ok(start.text.includes(marker), '文本附件正文必须真的进了 prompt');
  assert.ok(start.text.includes('<attachment name="规格.txt"'), '引用块要带文件名，模型才知道这段是谁的');
  assert.equal(start.text.includes('PNG') || start.text.includes('\u0000'), false, '二进制内容不许进 prompt');

  // 只带附件、不带文字：这是合理的提问方式，不能被 content 校验挡掉
  const only = await call('POST', '/api/kernel/sessions/' + sid + '/turns',
    { token: adminToken, json: { content: '', attachmentIds: [t1] } });
  assert.equal(only.status, 200, '只发附件应当被允许：' + only.text.slice(0, 300));
  assert.deepEqual(only.body.attachments.injected.map((x) => x.id), [t1]);

  // 既没文字也没有附件 → 仍然是 400（不要把"空请求"当成合法输入）
  const neither = await call('POST', '/api/kernel/sessions/' + sid + '/turns', { token: adminToken, json: { content: '   ' } });
  assert.equal(neither.status, 400);
  assert.ok(/附件/.test(neither.body.error.message), '报错要告诉用户"要么写字、要么带附件"');
});

/* ── 0.17.0 · 会话导出（转录）─────────────────────────────────────────────
 *
 * 导出的对象是**转录**，不是原始事件转储（原始转储是「治理 → 会话日志」的 log.zip）。
 * 所以这一节钉住的不是"文件能下载"，而是转录的**诚实性**：
 *   · 用户段 = 用户原文 —— 平台注入的检索/附件正文在**显示层**剥出（数据层不动，
 *     事件接口里仍有全文），剥出去的东西**如实注明**，不静默丢；
 *   · md 与 json 对同一会话是**同一份事实**的两种形态（json 的 kbCount 与 md 注记的
 *     条数逐数相等 —— 两个数对不上就说明有一条通路在撒谎）；
 *   · 纯附件轮（只有附件没有文字）在转录里是"附件轮"，不是"助手自说自话"。
 */

await t('导出会话：用户段=原文、注入段剥出并注明；md 与 json 是同一事实的两种形态', async () => {
  // 挂一个知识库、导一篇含检索词的文档 —— 让这一轮真的同时带知识段与附件段，
  // 否则"剥注入"测了个寂寞。
  const kb = await call('POST', '/api/knowledge/bases', { token: adminToken, json: { name: '导出回归库' } });
  assert.equal(kb.status, 201, kb.text.slice(0, 300));
  const kbId = kb.body.base.id;
  const doc = await call('POST', '/api/knowledge/documents', {
    token: adminToken,
    json: { kbId, filename: '导出规范.txt', text: '导出规范：KB-EXPORT-77 会话转录按 md 或 json 导出，注入段不进入用户发言。' },
  });
  assert.equal(doc.status, 201, doc.text.slice(0, 300));

  const s = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '导出回归', kbIds: [kbId] } });
  assert.equal(s.status, 201, s.text.slice(0, 300));
  const sid = s.body.session.id;
  assert.deepEqual(s.body.session.kbIds, [kbId], '建会话时挂的库要能立刻回显');

  const att = await upload(sid, '导出附件.txt', Buffer.from('ATT-EXPORT-88 附件正文不该出现在用户发言里。', 'utf8'), { token: adminToken });
  assert.equal(att.status, 201, att.text.slice(0, 300));
  const attId = att.body.attachment.id;

  // 第一轮：有文字 + 附件 → content = 用户原文 + 知识段 + 附件段
  const r1 = await call('POST', '/api/kernel/sessions/' + sid + '/turns', {
    token: adminToken, json: { content: '导出规范怎么讲？', attachmentIds: [attId] },
  });
  assert.equal(r1.status, 200, r1.text.slice(0, 400));
  const start1 = (r1.body.events || []).find((e) => e.type === 'turn-start');
  assert.ok(start1 && start1.text.includes('<<<STI-KNOWLEDGE>>>') && start1.text.includes('<<<STI-ATTACHMENTS>>>'),
    '前置条件：turn-start 必须同时含知识段与附件段（否则剥出逻辑没被测到）：' + String(start1 && start1.text).slice(0, 200));

  // 第二轮：纯附件轮（content 为空是合法的）—— 转录里必须如实呈现为"只有附件"
  const r2 = await call('POST', '/api/kernel/sessions/' + sid + '/turns', {
    token: adminToken, json: { content: '', attachmentIds: [attId] },
  });
  assert.equal(r2.status, 200, r2.text.slice(0, 300));

  // ── md：人读版 ──────────────────────────────────────────────
  const md = await call('GET', '/api/kernel/sessions/' + sid + '/export?format=md', { token: adminToken });
  assert.equal(md.status, 200, md.text.slice(0, 300));
  assert.equal(md.body.format, 'md');
  assert.equal(md.body.sessionId, sid);
  assert.equal(md.body.title, '导出回归');
  assert.equal(md.body.filename, '导出回归.md');
  assert.ok(md.body.eventCount > 0, '事件数要如实回报');
  assert.equal(md.body.truncated, false);

  const text = String(md.body.content);
  assert.ok(text.startsWith('# 导出回归'), '标题行应是会话标题');
  const userPart = text.split('## 助手')[0];
  assert.ok(userPart.includes('导出规范怎么讲？'), '用户段必须是用户原文');
  assert.equal(userPart.includes('<<<STI-'), false, '注入标记不许留在用户发言里');
  assert.equal(userPart.includes('KB-EXPORT-77'), false, '知识库正文不进用户发言（数据层仍有全文，见事件接口）');
  assert.equal(userPart.includes('ATT-EXPORT-88'), false, '附件正文不进用户发言');
  assert.ok(/> 本轮注入已从发言中剥出：/.test(userPart), '剥出去的必须注明，不静默丢');
  assert.ok(/附件正文 1 个/.test(userPart), '注记要如实数附件');

  // ── json：结构化形态 —— 与 md 同一份事实 ────────────────────
  const js = await call('GET', '/api/kernel/sessions/' + sid + '/export?format=json', { token: adminToken });
  assert.equal(js.status, 200, js.text.slice(0, 300));
  assert.equal(js.body.filename, '导出回归.json');
  const c = js.body.content;
  assert.equal(c.sessionId, sid);
  assert.ok(Array.isArray(c.messages) && c.messages.length >= 4, '两轮 → 至少两条用户段两条助手段');
  const users = c.messages.filter((m) => m.role === 'user');
  assert.equal(users.length, 2, '两轮提问 → 两段用户发言');
  assert.equal(users[0].text, '导出规范怎么讲？', 'json 用户段是对用户原文的**严格等值**（剥注入后连空白都不留）');
  assert.equal(users[0].injected.attachCount, 1);
  assert.ok(users[0].injected.kbCount >= 1, '知识片段条数 ≥1，实际 ' + users[0].injected.kbCount);
  assert.ok(text.includes('知识片段 ' + users[0].injected.kbCount + ' 条'),
    'md 注记条数与 json 结构化计数必须是同一个数（同一事实两种形态）');
  assert.equal(users[1].text, '');
  assert.equal(users[1].injected.attachCount, 1, '纯附件轮的注入计数在 json 里也要如实');
  assert.ok(text.includes('*（本轮只有附件，没有文字输入）*'), '纯附件轮不许在转录里变成"助手自说自话"');

  // ── 合规：导出留痕 ──────────────────────────────────────────
  const rows = audit.list(orgId, { limit: 200 }).filter((x) => x.action === 'kernel.session.export' && x.resource_id === sid);
  assert.ok(rows.length >= 2, '导出必须留痕（md/json 各一次），实际 ' + rows.length);
  assert.ok(rows.every((x) => x.resource_type === 'session' && x.result === 'ok'), '留痕要指向具体会话且记结果');
  const fmts = new Set(rows.map((x) => JSON.parse(x.detail_json).format));
  assert.ok(fmts.has('md') && fmts.has('json'), '留痕要带格式');
});

await t('导出：格式白名单与不存在的会话都"说得清"（400/404）；空会话导出是合法文档，viewer 可导出', async () => {
  const mk = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '空会话' } });
  const sid = mk.body.session.id;

  const bad = await call('GET', '/api/kernel/sessions/' + sid + '/export?format=xml', { token: adminToken });
  assert.equal(bad.status, 400);
  assert.ok(/format 只支持 md 或 json/.test(bad.body.error.message), '格式错误要点名支持什么，实际：' + bad.text.slice(0, 160));

  const nf = await call('GET', '/api/kernel/sessions/ks_not_exist/export', { token: adminToken });
  assert.equal(nf.status, 404);

  // 空会话：不是错误 —— 返回一份"零事件"的合法文档（前端可以放心下载）
  const em = await call('GET', '/api/kernel/sessions/' + sid + '/export', { token: adminToken });
  assert.equal(em.status, 200);
  assert.equal(em.body.format, 'md', '不传 format 默认 md');
  assert.equal(em.body.eventCount, 0);
  assert.equal(em.body.truncated, false);
  assert.ok(String(em.body.content).includes('# 空会话'));
  const ej = await call('GET', '/api/kernel/sessions/' + sid + '/export?format=json', { token: adminToken });
  assert.deepEqual(ej.body.content.messages, [], '空会话的消息段是空数组');

  // 只读访客（session:read）能导出 —— 与前端"导出按钮人人可见"同一门槛：
  // 能看见的会话就能带走，销掉这条通道只会把人逼去数据库里捞。
  const v = await call('GET', '/api/kernel/sessions/' + sid + '/export', { token: viewerToken });
  assert.equal(v.status, 200, 'viewer 有 session:read，导出应放行：' + v.text.slice(0, 200));
});

/* ── 0.10.0 · 图片附件：真的作为图片块送给模型 ─────────────────────────────
 *
 * 这一节钉住的是一个**被纠正的错误结论**。上一版（0.9.0）在四份文档里写着
 * 「平台没有给上游传新附件的通道（契约里的 readAttachment 是"读"，不是"写"）」，
 * 于是所有二进制（含图片）一律不送。
 *
 * 错在**只看契约的一半就推断了整体**：写入通道不在 `readAttachment` 上，
 * 而在 `submitTurn` 的 `content` 内容块数组里 ——
 *   @deepseek-ai/dsh-attachment/lib/types/types.d.ts 的 PromptContentPart
 *     | { type:'image'; mediaType:'image/png'|'image/jpeg'|'image/webp'|'image/gif';
 *         data: string /* base64 *\/; name?: string }
 * 且注释明写「调用方**不可能**引用一个自己没上传过的附件」——
 * 即**必须在提交那一刻把 base64 一起带上**。我们的 toBlocks() 对数组是原样透传，
 * 这条路一直是通的，只是没人走。
 */
await t('图片附件：按**内容**认定（不信扩展名与浏览器声明），且真的作为图片块提交给模型', async () => {
  const s = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '图片回归' } });
  const sid = s.body.session.id;

  // 一张**真实**的 1×1 PNG（魔数 89 50 4E 47 0D 0A 1A 0A）。刻意命名为 .txt：
  // 按内容判定就必须认出它是 PNG；上一版"看扩展名/看 mime"的做法在这里直接判错。
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64');
  const img = await upload(sid, '伪装成文本.txt', PNG, { token: adminToken });
  assert.equal(img.status, 201, img.text.slice(0, 300));
  assert.equal(img.body.attachment.mime, 'image/png',
    'mime 必须是平台按**魔数**嗅探出的真实类型，而不是浏览器声明的 octet-stream');
  assert.equal(img.body.delivery.mode, 'image');
  assert.ok(/模型能直接看到/.test(img.body.delivery.note),
    '要明说"模型能直接看到这张图" —— 这正是与通用文件的关键区别');

  // 浏览器**声明错**的情况：真 PNG 却报 image/jpeg。
  // 上游会因为"字节与声明类型不符"让**整条消息失败**（连文本一起不发），
  // 所以必须以内容为准、把声明覆盖掉 —— 这是本用例最要紧的一条。
  const liar = await upload(sid, 'x.png', PNG, { token: adminToken, headers: { 'content-type': 'image/jpeg' } });
  assert.equal(liar.body.attachment.mime, 'image/png',
    '浏览器声明 image/jpeg 但内容是 PNG → 必须存嗅探结果（照抄声明会让上游整条消息失败）');

  const r = await call('POST', '/api/kernel/sessions/' + sid + '/turns', {
    token: adminToken,
    json: { content: '看看这两张图', attachmentIds: [img.body.attachment.id, liar.body.attachment.id] },
  });
  assert.equal(r.status, 200, r.text.slice(0, 400));
  assert.equal(r.body.attachments.requested, 2);
  assert.equal(r.body.attachments.sent.length, 2, '两张图都要作为图片块送出去');
  assert.deepEqual(r.body.attachments.skipped, [], '图片不该出现在 skipped 里（上一版就是全在这里）');
  assert.deepEqual(r.body.attachments.injected, [], '图片不进"文本注入"那一栏 —— 它是另一条通路');

  // 落库的 turn-start 正文要自解释："这一轮除了文字还带了图，且图是真的送出去了"
  const start = (r.body.events || []).find((e) => e.type === 'turn-start');
  assert.ok(start.text.startsWith('看看这两张图'), '用户原始输入仍在最前面');
  assert.ok(/2 张图片/.test(start.text), '正文里要报出图片张数（只读 API 的调用方才知道这轮带了图）');
  assert.ok(/已作为图片内容块提交给模型/.test(start.text), '要写明是"真的提交了"，不是"仅登记"');
  assert.ok(/伪装成文本\.txt/.test(start.text), '每张图都要点名');
  // 反向：图片的**字节**不许被塞进正文（那才是"用文本假装送了图"）
  assert.equal(start.text.includes(PNG.toString('base64').slice(0, 24)), false,
    '图片不许以 base64 形式混进正文 —— 它走的是结构化内容块，不是文本');

  // 测试替身的回执：证明**平台确实把图片块送到了 provider 这一层**，
  // 而不只是平台内部记了一笔账。
  const stubSaid = JSON.stringify(r.body.events);
  assert.ok(/收到 2 个图片内容块/.test(stubSaid), '测试替身 必须如实回报收到了 2 个图片块');
  assert.ok(/没有视觉能力/.test(stubSaid), '测试替身 不许编造"看见了图"（它没有视觉能力）');
});

await t('图片附件：本轮合计超预算时如实点名，且**不把超出的图塞进请求体**', async () => {
  const s = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '图片预算' } });
  const sid = s.body.session.id;

  const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // 两张各 6MB 的"PNG"（魔数正确即可被嗅探认出）。合计 12MB > IMAGE_TOTAL_MAX(10MB)。
  const big = (n) => Buffer.concat([PNG_HEAD, Buffer.alloc(n * 1024 * 1024 - 8, 0x41)]);
  const a = await upload(sid, 'big-a.png', big(6), { token: adminToken });
  const b = await upload(sid, 'big-b.png', big(6), { token: adminToken });
  assert.equal(a.status, 201, a.text.slice(0, 200));
  assert.equal(b.status, 201, '单张 6MB < 上传上限 8MB，应当存得下');
  assert.equal(a.body.delivery.mode, 'image');

  const r = await call('POST', '/api/kernel/sessions/' + sid + '/turns', {
    token: adminToken,
    json: { content: '两张都看看', attachmentIds: [a.body.attachment.id, b.body.attachment.id] },
  });
  assert.equal(r.status, 200, '预算超了是"少送一张"，不是"整轮失败"：' + r.text.slice(0, 300));
  assert.equal(r.body.attachments.sent.length, 1, '第一张在预算内，应当送出去');
  assert.equal(r.body.attachments.skipped.length, 1, '第二张超出预算，必须如实点名');
  assert.equal(r.body.attachments.skipped[0].reason, 'image_budget');
  assert.ok(/上限/.test(r.body.attachments.skipped[0].note), '要说清是撞了哪条上限');

  // 关键：预算的意义就是**不让超出的图进请求体**。若这里已经撑出 16MB，
  // 上一句 assert(status,200) 就会变成 413 —— 那说明预算是摆设。
  // 这里再正面确认一次：服务端确实只装了一张。
  const start = (r.body.events || []).find((e) => e.type === 'turn-start');
  assert.ok(/1 张图片/.test(start.text), '正文里只该说 1 张（超预算的那张不许写进去）');
  assert.equal(/big-b\.png/.test(start.text), false, '没送出去的图不该出现在"已提交"清单里');
});

await t('附件：超过单文件上限 → 413（拒绝而不是静默截断）', async () => {
  const s = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '上限回归' } });
  const sid = s.body.session.id;
  const big = Buffer.alloc(8 * 1024 * 1024 + 1024, 0x61);      // 8MB + 1KB
  const r = await upload(sid, 'big.txt', big, { token: adminToken });
  assert.equal(r.status, 413, '超限要 413，不能默默截断成一个"能下载但不全"的文件');
  assert.ok(/过大/.test(r.body.error.message));
});

/* ── 会话内检索：整块删除（0.21.7）─────────────────────────────────────
 *
 * 这里曾有一条用例，钉的是：在**已落库事件**里搜（而不是前端已加载的那 2000 条）、
 * 排除只命中结构化字段的假阳性、LIKE 通配符被转义（搜一个 % 不能变成"匹配一切"）、
 * 未登录 401、缺 q 400。
 *
 * 用户裁定「右上角（会话内搜索删除…）」→ 追问时选**整块删除**，于是路由
 * `kernel.sessions.search` 与仓储 `events.searchEvents` 一起删了，这条用例随之去掉
 * （留着它会测一个路由表里已经不存在的接口）。
 *
 * ⚠️ 那是一套**正确**的设计，要加回来时请连同上面这四条口径一起复活：
 *   ① 服务端搜（前端只回放最近 2000 条，纯前端过滤会在长会话里给出"搜不到"的错误结论）；
 *   ② 按"可见文本（正文 / 推理增量）"复核一次，把只命中结构化字段的假阳性挡掉；
 *   ③ `LIKE` 通配符转义 + `ESCAPE '\\'`；
 *   ④ 归属校验走 `sessions.getSession(tenantId, id)`（检索不是隔离的例外通道）。
 */


await t('停止：会通知上游取消、留审计、并如实回报"上游是否真的停了"', async () => {
  const s = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '停止回归' } });
  const sid = s.body.session.id;
  await call('POST', '/api/kernel/sessions/' + sid + '/turns', { token: adminToken, json: { content: '会被停止的一轮' } });

  const anon = await call('POST', '/api/kernel/sessions/' + sid + '/cancel', { json: { turnId: 'kt_x' } });
  assert.equal(anon.status, 401);
  const v = await call('POST', '/api/kernel/sessions/' + sid + '/cancel', { token: viewerToken, json: { turnId: 'kt_x' } });
  assert.equal(v.status, 403, '停止要 session:execute（查看权限不够）');

  const c = await call('POST', '/api/kernel/sessions/' + sid + '/cancel', { token: adminToken, json: { turnId: 'kt_x' } });
  assert.equal(c.status, 200, c.text.slice(0, 300));
  assert.equal(c.body.cancelled, true);
  assert.equal(c.body.turnId, 'kt_x', '要把 turnId 回显出来 —— 否则"取消了哪一轮"无从核对');
  assert.equal(c.body.upstream.attempted, true, '必须真的去通知上游，而不是只断本地读取');
  assert.equal(c.body.upstream.ok, true, '测试替身 的 cancelTurn 是空实现但**不抛错**，所以这是 ok');
  assert.ok(/已落库|丢弃/.test(c.body.note), 'note 要说明"已收到的部分不会丢"');

  // 留痕：停止是一次治理动作，审计里必须查得到（否则"谁把这一轮掐了"永远查不清）
  const org = audit.list(orgId, { limit: 800 });
  const rows = org.filter((r) => r.action === 'kernel.session.cancel');
  assert.ok(rows.length >= 1, '停止必须留审计');
  assert.equal(JSON.parse(rows[rows.length - 1].detail_json).turnId, 'kt_x', '审计要记下取消的是哪一轮');
});

await t('附件与事件都不跨租户：换个租户的令牌一律 404（不是空列表）', async () => {
  const s = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '跨租户回归' } });
  const sid = s.body.session.id;
  const up = await upload(sid, 'tenant.txt', Buffer.from('private', 'utf8'), { token: adminToken });
  const aid = up.body.attachment.id;

  // 第二个组织 + 一个 admin（owner 是初始化向导专属，第二个组织只能用 admin），
  // 与 test-governance 的双租户做法保持同一套（身份体系没有"建组织"的 HTTP 入口）。
  const orgs = await import('../app/platform/identity/repos/orgs.mjs');
  const roles = await import('../app/platform/identity/repos/roles.mjs');
  const org2 = orgs.createOrg({ name: '隔离组织C', slug: 'iso-c-' + Date.now() });
  roles.ensureBuiltinRoles(org2.id);        // 向导之外建组织必须补种内置角色
  await identity.createUser({ orgId: org2.id, username: 'admin-c', password: 'Adm1n-Pass!23', displayName: 'C管理员', roleKeys: ['admin'] });
  const lg2 = await call('POST', '/api/identity/login', { json: { username: 'admin-c', password: 'Adm1n-Pass!23', orgSlug: org2.slug } });
  assert.equal(lg2.status, 200, lg2.text.slice(0, 300));
  const otherToken = lg2.body.token;
  assert.ok(otherToken);

  for (const [label, p] of [
    ['列表', '/api/kernel/sessions/' + sid + '/attachments'],
    ['下载', '/api/kernel/sessions/' + sid + '/attachments/' + aid],
    // 0.21.7：这里原本还有一条「检索」（/search?q=…）。会话内检索整块删除，换成**事件列表** ——
    // 隔离这条用例要的是"另一个会话级 GET 口也不跨租户"，换一支同类接口才不丢覆盖面。
    ['事件', '/api/kernel/sessions/' + sid + '/events'],
  ]) {
    const r = await call('GET', p, { token: otherToken });
    assert.equal(r.status, 404, label + '：跨租户必须 404（不能泄漏"这个会话存在"）');
  }
  const d = await call('DELETE', '/api/kernel/sessions/' + sid + '/attachments/' + aid, { token: otherToken });
  assert.equal(d.status, 404, '跨租户删除必须 404');
  // 反向确认：原租户的东西一点没少
  const still = await call('GET', '/api/kernel/sessions/' + sid + '/attachments', { token: adminToken });
  assert.equal(still.body.count, 1, '跨租户的删除尝试不许真的删掉别家的附件');
});

/* ── 知识库级授权（§B9 的图形化入口依赖这几条语义，必须在**线上**钉住）──────────
 * 这一段存在的理由：库级授权的权限判定**不在路由门**上（路由只要 `knowledge:read`），
 * 而在服务层按**该库**的 write 档判。于是"界面上该不该给这个面板"最终取决于服务端的结论，
 * 前端只能照实呈现 —— 所以拒绝的**状态码必须可理解**：404（库/主体不可见）与 403（看得见但档位不够）
 * 是两件不同的事，任何一个都不该被笼统的 500 吞掉。
 */

await t('库级授权：状态码把"不可见(404)"与"档位不够(403)"分开；给不存在的主体授权是 404 而非 500', async () => {
  const cb = await call('POST', '/api/knowledge/bases', {
    token: adminToken, json: { name: 'HTTP 受限库', visibility: 'restricted' },
  });
  assert.equal(cb.status, 201, '建受限库应 201：' + cb.text.slice(0, 200));
  const kbId = cb.body.base.id;
  assert.equal(cb.body.base.visibility, 'restricted', '可见性要真的落成 restricted');

  // ① admin（本库有 write 档）能列名单，新库是空的
  const l0 = await call('GET', '/api/knowledge/bases/' + kbId + '/grants', { token: adminToken });
  assert.equal(l0.status, 200, 'admin 应能列名单：' + l0.text.slice(0, 200));
  assert.deepEqual(l0.body.grants, [], '新库不该凭空有授权');

  // ② 未获授权的普通成员：受限库**对他不存在** → 404（不是"空名单"，那等于确认了库的存在）
  const lv0 = await call('GET', '/api/knowledge/bases/' + kbId + '/grants', { token: viewerToken });
  assert.equal(lv0.status, 404, '不受限可见的库必须按不存在处理，实际 ' + lv0.status + '：' + lv0.text.slice(0, 160));

  // ③ 授权给一个真实成员（只读档）
  const g = await call('POST', '/api/knowledge/bases/' + kbId + '/grants', {
    token: adminToken, json: { subjectType: 'user', subjectId: viewerId, roleKey: 'viewer' },
  });
  assert.equal(g.status, 201, '授权应 201：' + g.text.slice(0, 200));
  const bindingId = g.body.grant && g.body.grant.id;
  assert.ok(bindingId, '授权响应必须带回绑定 id（撤销要用它）');

  // ④ 同一个成员现在**看得见**这个库了，所以再读名单变成 403（看得见，但档位不够）——
  //    这一格是整段的重点：④ 与 ② 是同一个人、同一个接口，只因可见性变了，状态码就从
  //    404 变成 403。两个数混成一个，就等于把"组织架构"与"权限"又揉回了一起。
  const lv1 = await call('GET', '/api/knowledge/bases/' + kbId + '/grants', { token: viewerToken });
  assert.equal(lv1.status, 403, '看得见但没 write 档应是 403，实际 ' + lv1.status + '：' + lv1.text.slice(0, 160));

  // ⑤ 主体不存在 → 404。**这是本轮修的缺陷**：原先服务层没校验主体，裸 Error 出网变
  //    500 internal_error，于是"这个人已经被删了"在界面上显示成"服务器坏了"。
  //    授权入口有界面之后，下拉里的 id 在"加载后被删"的竞态下会陈旧，这条路真实可达。
  const badSubj = await call('POST', '/api/knowledge/bases/' + kbId + '/grants', {
    token: adminToken, json: { subjectType: 'user', subjectId: 'no_such_user', roleKey: 'viewer' },
  });
  assert.equal(badSubj.status, 404,
    '不存在的授权主体必须 404（不是 500），实际 ' + badSubj.status + '：' + badSubj.text.slice(0, 200));
  assert.notEqual(badSubj.body.error.code, 'internal_error', '不得落成 internal_error');

  // ⑥ 空主体 → 400；未知角色 → 400（都是"请求本身不对"，不是"服务器坏了"）
  const emptySubj = await call('POST', '/api/knowledge/bases/' + kbId + '/grants', {
    token: adminToken, json: { subjectType: 'user', subjectId: '', roleKey: 'viewer' },
  });
  assert.equal(emptySubj.status, 400, '空主体应是 400，实际 ' + emptySubj.status);
  const badRole = await call('POST', '/api/knowledge/bases/' + kbId + '/grants', {
    token: adminToken, json: { subjectType: 'user', subjectId: viewerId, roleKey: 'not_a_role' },
  });
  assert.equal(badRole.status, 400, '未知角色应是 400，实际 ' + badRole.status);

  // ⑦ 三次被拒的请求都不得落库（"静默存下一条永不生效的授权"是最难查的形态）
  const l1 = await call('GET', '/api/knowledge/bases/' + kbId + '/grants', { token: adminToken });
  assert.equal(l1.body.grants.length, 1, '只应有 ③ 那一条，实际 ' + JSON.stringify(l1.body.grants));
  assert.equal(l1.body.grants[0].subjectName, 'viewer1', 'subjectName 要回填用户名（否则页面只能显示一串内部 id），实际 '
    + JSON.stringify(l1.body.grants[0]));

  // ⑧ 撤销 → 200；再撤同一条 → 404（撤不存在的绑定不能静默成功）
  const rv = await call('DELETE', '/api/knowledge/bases/' + kbId + '/grants/' + bindingId, { token: adminToken });
  assert.equal(rv.status, 200, '撤销应 200：' + rv.text.slice(0, 200));
  const rv2 = await call('DELETE', '/api/knowledge/bases/' + kbId + '/grants/' + bindingId, { token: adminToken });
  assert.equal(rv2.status, 404, '重复撤销应 404（幂等只到"绑定的唯一性"为止），实际 ' + rv2.status);

  // ⑨ 撤权后该成员立刻回到"看不见"（不残留）
  const lv2 = await call('GET', '/api/knowledge/bases/' + kbId + '/grants', { token: viewerToken });
  assert.equal(lv2.status, 404, '撤权后必须重新不可见，实际 ' + lv2.status);
});

/* ── 12. 内核接入向导（P0）──────────────────────────────────────────
 *
 * 为什么这一组必须有：它把"接上真实内核"从**只有写代码的人能做**（登上服务器改
 * `data/config.json` 再重启）变成任何人都能在页面上做。权限一旦划错，
 * 等于把"服务端会主动去连任意地址"（SSRF 形状）开放给整个组织；
 * 令牌一旦写错成明文，等于引入一个比原来更糟的存法。两条都用回归钉住。
 */
section('内核接入向导：检测 / 保存（管理员专属；令牌只写密文）');

/** 起一个扮演"上游内核"的桩服务端；返回 { port, close } */
async function stubKernel(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

/**
 * 一个会被**探成"内核可用"**的页面。
 * 探测只看响应特征（HTML 里带内核的启动标记），不看对面真的做了什么 ——
 * 这个字符串就是那条判据的输入，所以它只该有一份（从前在这里抄了三遍）。
 */
const KERNEL_LOOKING_PAGE = '<html><script>window.__DSH_BOOT__={"rev":"abcdef123456"}</script>DeepSeek Harness</html>';

/**
 * 起一个"可用内核"的桩。
 *
 * ⚠️ 0.21.5 起**保存的前提是检测通过**，所以凡是"要真的把配置写进去"的用例
 * 都得用这个，而不是随便填一个地址（以前还能靠 `force` 硬写，那条路已经删了）。
 */
async function liveKernelStub() {
  return stubKernel((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(KERNEL_LOOKING_PAGE);
  });
}

/** 拿一个确定没人听的端口 */
async function deadPort() {
  const s = await stubKernel((req, res) => res.end('x'));
  const p = s.port;
  await s.close();
  return p;
}

await t('★ 内核接入的权限边界：未登录 401；有 system:read 但没 system:write 一律 403', async () => {
  const anon = await call('POST', '/api/system/kernel/probe', { json: { origin: 'http://127.0.0.1:1' } });
  assert.equal(anon.status, 401, '未登录不得探测');

  // 探测会让**服务端**主动去连调用方指定的地址（可以指向内网任何主机）——
  // 这是一个 SSRF 形状的动作，必须是"写"权限，不能是"读"。
  const v = await call('POST', '/api/system/kernel/probe', {
    token: viewerToken, json: { origin: 'http://127.0.0.1:1' },
  });
  assert.equal(v.status, 403, 'viewer 不得发起探测，实际 ' + v.status);
  assert.deepEqual(v.body.error.detail.needs, ['system:write']);

  const v2 = await call('POST', '/api/system/kernel/config', {
    token: viewerToken, json: { origin: 'http://127.0.0.1:1' },
  });
  assert.equal(v2.status, 403, 'viewer 不得改内核接入');
});

await t('★ 检测：按真实 HTTP 响应分类，且「连上了但要令牌」与「连不上」必须分开', async () => {
  const needsToken = await stubKernel((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh web authentication required');
  });
  try {
    const r = await call('POST', '/api/system/kernel/probe', {
      token: adminToken, json: { origin: 'http://127.0.0.1:' + needsToken.port },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.probe.state, 'need-token');
    assert.equal(r.body.probe.reachable, true, '它是"连上了但要令牌"，不是"连不上"');
    assert.equal(r.body.probe.ok, false);
    assert.equal(r.body.probe.stage, '鉴权');
    assert.ok(r.body.probe.hint.length > 0, '必须给出下一步');
  } finally { await needsToken.close(); }

  // 桩故意在 Server 头与响应体里都写上游产品名 —— 复现真机验收看到的那一屏：
  //   「该地址有响应，但不像是 DSH（HTTP 200，Server: …）」
  // 那句话的字面在 dsh-provider（分层审计的豁免区）里，**靠运行期字符串穿到界面**，
  // 所以源码静态扫描永远是绿的 —— 只有"真的打一次请求再扫响应体"才抓得到。
  const notKernel = await stubKernel((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', server: 'DSH-Edge' });
    res.end('<html><body>DSH 内部首页</body></html>');
  });
  try {
    const r = await call('POST', '/api/system/kernel/probe', {
      token: adminToken, json: { origin: 'http://127.0.0.1:' + notKernel.port },
    });
    assert.equal(r.body.probe.state, 'not-kernel', '有响应但不认识 —— 与"连不上"是两回事');
    assert.equal(r.body.probe.reachable, true);
    assert.ok(r.body.probe.server && r.body.probe.server.includes('内核'),
      '响应头里的服务名要抹掉上游名：' + r.body.probe.server);
    assert.ok(!/dsh/i.test(JSON.stringify(r.body)),
      '响应体里出现了上游产品名（静态审计看不见的那一类）：' + JSON.stringify(r.body));
  } finally { await notKernel.close(); }

  const dead = await deadPort();
  const r3 = await call('POST', '/api/system/kernel/probe', {
    token: adminToken, json: { origin: 'http://127.0.0.1:' + dead, timeoutMs: 2000 },
  });
  assert.equal(r3.body.probe.state, 'unreachable');
  assert.equal(r3.body.probe.reachable, false);
  assert.ok(r3.body.probe.detail.length > 0, '连不上也要说清是什么错');
});

await t('★ 运行期扫描：代表性接口的响应体里都不得出现上游产品名', async () => {
  // 为什么要有这条（与静态审计分工）：`tools/audit-layering.mjs` 保证"产品层源码里没写上游名"，
  // 但它证明不了"响应体里没有上游名" —— 名字可以从契约层经**运行期字符串**流过来
  // （真机验收就是这么抓到「不像是 DSH」显示在接入向导里的）。
  // 这条把每个有代表性的接口真打一遍，扫原始响应文本，是那条静态审计的**运行期补充**。
  const paths = [
    '/api/health', '/api/system/status', '/api/kernel/status', '/api/identity/me',
    '/api/identity/permissions', '/api/capability/skills', '/api/capability/bindings',
    '/api/knowledge/bases', '/api/governance/audit', '/api/governance/quotas',
    '/api/models', '/api/schedules', '/api/notify/channels', '/api/backups',
  ];
  /**
   * 允许出现的**运维接口名**（配置文件键 / 环境变量名）。
   *
   * 这是一份**带根据的白名单**，不是"扫到就放行"的豁免单：
   *   · 范围**只到标识符**（`dshOrigin` 这类键名），不含任何散文 —— 散文一律不许带名；
   *   · 每一条都是**已经部署出去的接口契约**：`data/config.json` 里就叫这个键、
   *     环境变量就叫这个名字（`app/config.mjs` 的 ENV_NAMES 是它们的单一真相源）。
   *     改名的代价是"已部署的配置文件失效"，这比"界面上出现一个运维看得懂的键名"严重得多；
   *   · 它们出现在响应的 `sources` 映射里（哪一项来自环境变量 / 默认值），是**给运维排查用的**。
   * 白名单必须带根据 —— 一份不会过期的白名单就是一份假白名单（本项目已有先例）。
   */
  const OPERATOR_IFACE = /\b(dshOrigin|dshToken|dshTokenCipher|dshProfile|dshBin|DSH_ORIGIN|DSH_TOKEN|DSH_PROFILE|DSH_BIN|DSH_HOME)\b/g;

  const dirty = [];
  for (const p of paths) {
    const r = await call('GET', p, { token: adminToken });
    // 先把运维接口名替换掉，再扫 —— 剩下的任何一处上游名都是**真泄漏**
    const blob = JSON.stringify(r.body === undefined ? '' : r.body).replace(OPERATOR_IFACE, '<运维接口名>');
    /**
     * ⚠️ 匹配必须带**词边界** —— 0.21.0 修掉的一处**假红**。
     *
     * 原来这里就是 `/dsh/i`：它会把**随机 id 里的三个字母**当成产品名命中。
     * id 形如 `att_0muwf2dshfb69cb470dd9`（前缀 + base32 尾串），尾串天然可能拼出 "dsh"；
     * 而 `/api/governance/audit` 一次返回上百条带 id 的记录，于是这条守卫**按概率**变红，
     * 红的时候指着一枚与产品名毫无关系的附件 id —— 排查的人只能去怀疑数据。
     *
     * 假红比假绿温和，但它一样会让人开始忽略这条守卫。而这条守卫**不是装饰**：
     * 它正是当初抓到「不像是 DSH」显示在接入向导里的那一条（注释第 3 行），
     * 静态审计查不到运行期字符串，只能靠它。一条会被随机数据点着的守卫，
     * 迟早会被当成噪声跳过，那才是真正的代价。
     *
     * 所以判据收紧成：**"dsh" 只要还粘在长标识符里就不算命中**（前后都不是字母数字）。
     * 代价如实写在这里：`dshModelVersion` 这类"嵌在别的词中间"的标识符不再被拦 ——
     * 但运维接口名已由上面的 OPERATOR_IFACE 逐条点名列替换，那是分工，不是漏网。
     */
    const UPSTREAM_NAME = /(?<![A-Za-z0-9])dsh(?![A-Za-z0-9])/i;
    const m = UPSTREAM_NAME.exec(blob);
    // 失败信息里带上**上下文片段**：只报出路径的话，还得自己去翻响应体才知道漏在哪
    if (m) dirty.push(p + ' :: …' + blob.slice(Math.max(0, m.index - 60), m.index + 60) + '…');
  }
  assert.deepEqual(dirty, [], '这些接口的响应体里出现了上游产品名：' + dirty.join(' ｜ '));
});

await t('检测：地址非法 → 400（不打网络）；格式正确但危险协议 → bad-origin 而不是崩', async () => {
  const empty = await call('POST', '/api/system/kernel/probe', { token: adminToken, json: { origin: '' } });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.probe.state, 'bad-origin', '空地址要给出"地址不能为空"，不是 500');

  const bad = await call('POST', '/api/system/kernel/probe', {
    token: adminToken, json: { origin: 'file:///etc/passwd' },
  });
  assert.equal(bad.body.probe.state, 'bad-origin');
  assert.equal(bad.body.probe.reachable, false);
  assert.match(bad.body.probe.hint, /http/);
});

await t('★ 保存：**检测没通过就不保存**，没有任何旁路（0.21.5 删掉了 force）', async () => {
  const dead = await deadPort();
  const cfgFile = path.join(DATA_DIR, 'config.json');
  const readIfExists = () => { try { return fs.readFileSync(cfgFile, 'utf8'); } catch { return null; } };
  const before = readIfExists();

  const r = await call('POST', '/api/system/kernel/config', {
    token: adminToken, json: { origin: 'http://127.0.0.1:' + dead },
  });
  assert.equal(r.status, 409, '连不上的地址不该被保存，实际 ' + r.status);
  assert.equal(r.body.error.code, 'kernel_not_ready');
  assert.ok(r.body.error.detail.probe, '409 要带回完整诊断，前端不必再探一次');
  assert.equal(r.body.error.detail.probe.state, 'unreachable');
  assert.equal(readIfExists(), before, '被拒的保存不得产生任何副作用');
  assert.equal(kernel.ready, true, '被拒的保存不得改变运行中的内核');

  // 老客户端还会带 `force: true`（0.21.5 之前它是"跳过检测"的口子）。
  // 这条断言的意义不是"兼容老前端"，而是**防它被人加回来**：
  // 那条旁路的代价很具体 —— 用户省下一次点击，换来"保存成功、平台却没接入上"，
  // 而这恰恰是最难自查的一种失败（界面显示"已保存"）。留着这条红，加回来就当场知道。
  const forced = await call('POST', '/api/system/kernel/config', {
    token: adminToken, json: { origin: 'http://127.0.0.1:' + dead, force: true },
  });
  assert.equal(forced.status, 409, 'force 不再是旁路：检测没过就不保存');
  assert.equal(forced.body.error.code, 'kernel_not_ready');
  assert.equal(kernel.ready, true, '被拒的保存不得改变运行中的内核');
  assert.equal(readIfExists(), before, '被拒的保存不得写文件');
});

await t('★ 保存：令牌以**密文**落盘，配置文件里不出现明文；别的配置项原样保留', async () => {
  const cfgFile = path.join(DATA_DIR, 'config.json');
  // 先塞一个"运维手写"的别的配置项，验证向导保存一次不会把它抹掉
  let pre = {};
  try { pre = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { pre = {}; }
  pre.embeddingModel = 'text-embedding-3-small';
  pre.chunkMaxChars = 900;
  fs.writeFileSync(cfgFile, JSON.stringify(pre, null, 2));

  const SECRET = 'tok-super-secret-value-987';
  const ok = await liveKernelStub();
  try {
    const r = await call('POST', '/api/system/kernel/config', {
      token: adminToken,
      // ⚠️ 这里**故意**多带一个 `kernel: 'auto'`：0.21.4 之前的老前端会这么传。
      // 服务端必须当它不存在（不是报 400），否则升级后老页面一打开就保存不了。
      json: { origin: 'http://127.0.0.1:' + ok.port + '/?token=' + SECRET, kernel: 'auto' },
    });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.body.probe.state, 'ok');
    assert.equal(r.body.applied.hasToken, true);

    const text = fs.readFileSync(cfgFile, 'utf8');
    // ① 明文令牌绝不能出现在文件里（否则等于把凭据明文落盘，比原来更糟）
    assert.ok(!text.includes(SECRET), '配置文件里不得出现明文令牌');
    // ② 响应体里也不许回显令牌（它会被浏览器/日志留存）
    assert.ok(!r.text.includes(SECRET), '响应体不得回显令牌');
    // ③ 密文键在，且不是明文
    const after = JSON.parse(text);
    assert.ok(typeof after.dshTokenCipher === 'string' && after.dshTokenCipher.length > 20, '应有密文令牌');
    assert.ok(!('dshToken' in after), '不得留下明文键');
    assert.equal(after.dshOrigin, 'http://127.0.0.1:' + ok.port, '地址要写进去');
    // 0.21.4：不再有 kernel 模式这个键（连同 mock 一起删了）
    assert.ok(!('kernel' in after), '配置文件里不该再有 kernel 键');
    // ④ 运维手写的别的配置项必须还在
    assert.equal(after.embeddingModel, 'text-embedding-3-small', '不认识的键不许被抹掉');
    assert.equal(after.chunkMaxChars, 900);

    // ⑤ 令牌确实能解回来（值对，不是写了个随机串）
    assert.equal(decryptSecret(after.dshTokenCipher, MASTER), SECRET, '密文要能解出原令牌');
  } finally { await ok.close(); }
});

await t('★ kernel.status 报出「配置改了但还没生效」—— 对账的是两个客观值', async () => {
  // 造出"文件与运行值不一致"：**直接手改配置文件**（模拟运维登服务器改的那种情形）。
  //
  // 从前这条用例不需要手改 —— 当年回归全局设着 `STI_KERNEL`，那层环境变量覆盖
  // 让"保存了也不生效"成为默认状态。0.21.4 删掉那个开关后，**保存就是生效**，
  // 唯一还能造成"文件 ≠ 运行值"的就是有人绕过接口直接改文件。所以这里就这么造。
  restoreStubKernel();                    // 运行中：测试替身（dshStatus 为 null）
  const cfgFile = path.join(DATA_DIR, 'config.json');
  const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cur.dshOrigin = 'http://127.0.0.1:9/';  // 与运行中的那个不同（一个"运维手改"的地址）
  const { writeConfigFile } = await import('../app/config.mjs');
  writeConfigFile(cur);

  const r = await call('GET', '/api/kernel/status', { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.restart, 'kernel.status 要带 restart 结论');
  assert.equal(r.body.restart.pending, true, '文件与运行中不一致 → 待重启');
  assert.ok(r.body.restart.changed.includes('dshOrigin'));
  assert.match(r.body.restart.note, /重启/);
  // 这条只对**登录用户**可见：它带着配置文件里的地址，不该放进 public 的状态接口
  const pub = await call('GET', '/api/system/status');
  assert.ok(!pub.body.kernel.restart, 'public 状态接口不得带出配置文件里的地址');
});

await t('保存：老配置里的 kernel 键会被清掉（那是个已删除的开关）', async () => {
  // 0.21.4 删掉了内核模式。历史 config.json 里可能还留着 `kernel: "auto"` ——
  // 不清掉的话，后来读这份配置的人会以为还有这个开关（而任何代码都不再读它）。
  const cfgFile = path.join(DATA_DIR, 'config.json');
  const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cur.kernel = 'auto';
  fs.writeFileSync(cfgFile, JSON.stringify(cur, null, 2));

  // ⚠️ 必须指向一个**真的可用**的内核桩：0.21.5 起保存的前提是检测通过，
  // 从前这里能写 `force: true` + 一个死地址，那条路已经删了。
  const up = await liveKernelStub();
  try {
    const r = await call('POST', '/api/system/kernel/config', {
      token: adminToken, json: { origin: 'http://127.0.0.1:' + up.port },
    });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const after = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.ok(!('kernel' in after), '保存后 kernel 键应被清掉：' + JSON.stringify(after));
  } finally {
    await up.close();
    restoreStubKernel();
  }
});

/* ── 平台设置（0.16.0）：config.json 运行参数的界面出口 ──────────── */

await t('设置清单：白名单键 + 来源 + 锁定状态；密钥与内核键不得进设置页；未登录 401', async () => {
  const anon = await call('GET', '/api/system/settings');
  assert.equal(anon.status, 401);

  const r = await call('GET', '/api/system/settings', { token: adminToken });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.body.file, path.join(DATA_DIR, 'config.json'), '设置页对账的就是那份配置文件');
  const keys = r.body.settings.map((s) => s.key);
  assert.ok(keys.length >= 17, '白名单键数：' + keys.length);
  for (const k of ['dshToken', 'dshTokenCipher', 'dshOrigin', 'dshProfile', 'kernel', 'turnTimeoutMs', 'requireSetup']) {
    assert.ok(!keys.includes(k), '密钥/内核键不得经设置页管理：' + k);
  }
  const byKey = Object.fromEntries(r.body.settings.map((s) => [s.key, s]));
  // 上一节内核向导测试已把这两个值写进 config.json —— 读到的必须是它们的来源与值
  assert.equal(byKey.embeddingModel.value, 'text-embedding-3-small');
  assert.equal(byKey.embeddingModel.source, 'config.json');
  assert.equal(byKey.chunkMaxChars.value, 900);
  // 类型标记要能驱动前端渲染（number/boolean/string 三类都有）
  assert.ok(keys.includes('port') && byKey.port.type === 'number');
  assert.ok(byKey.trustProxy.type === 'boolean' && byKey.host.type === 'string');
});

await t('设置写入：类型/范围校验在服务端生效；未知键与密钥键一律 400', async () => {
  for (const [label, settings] of [
    ['未知键', { noSuchKey: 1 }],
    ['密钥键', { dshToken: 'hack' }],
    ['内核键', { kernel: 'stub' }],
    ['非数字端口', { port: 'not-a-number' }],
    ['越界端口', { port: 70000 }],
    ['非布尔', { trustProxy: 'yes' }],
    ['非整数', { workerPoolSize: 1.5 }],
    ['空补丁', {}],
  ]) {
    const r = await call('PUT', '/api/system/settings', { token: adminToken, json: { settings } });
    assert.equal(r.status, 400, label + ' 必须被拒，实际 ' + r.status);
    assert.equal(r.body.error.code, 'bad_request');
  }
  // viewer 有 system:read 可读，但写一律 403
  const v = await call('PUT', '/api/system/settings', { token: viewerToken, json: { settings: { sessionTtlHours: 1 } } });
  assert.equal(v.status, 403);
  assert.deepEqual(v.body.error.detail.needs, ['system:write']);
});

await t('★ 设置写入：合并落盘 —— 白名单键更新、令牌密文等未收录键原样保留、重启提示在场', async () => {
  const cfgFile = path.join(DATA_DIR, 'config.json');
  const before = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.ok(before.dshTokenCipher, '前置：内核向导已写入密文令牌');

  const r = await call('PUT', '/api/system/settings', {
    token: adminToken,
    json: { settings: { chunkMaxChars: 1000, sessionTtlHours: 24, prefilterVector: true, host: '127.0.0.1' } },
  });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.body.saved, true);
  assert.deepEqual([...r.body.updated].sort(), ['chunkMaxChars', 'host', 'prefilterVector', 'sessionTtlHours']);
  assert.equal(r.body.restartRequired, true, '运行参数在装配期读入进程，必须明说需要重启');

  const after = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.equal(after.chunkMaxChars, 1000, '提交的键要写进文件');
  assert.equal(after.sessionTtlHours, 24);
  assert.equal(after.prefilterVector, true);
  assert.equal(after.dshTokenCipher, before.dshTokenCipher, '密文令牌不得被设置保存抹掉');
  assert.equal(after.dshOrigin, before.dshOrigin, '内核地址不归设置页管，必须原样保留');
  assert.equal(after.kernel, before.kernel, '内核模式不归设置页管');
  assert.equal(after.embeddingModel, 'text-embedding-3-small', '本次没提交的键保持原值');

  // GET 再读：值与来源都跟上
  const g = await call('GET', '/api/system/settings', { token: adminToken });
  const byKey = Object.fromEntries(g.body.settings.map((s) => [s.key, s]));
  assert.equal(byKey.chunkMaxChars.value, 1000);
  assert.equal(byKey.chunkMaxChars.source, 'config.json');
});

/* ── 会话管理（0.16.0）：改名与删除 ─────────────────────────────── */

await t('会话改名：PATCH 只改标题；空标题 400；不存在 404；只读账号 403', async () => {
  const mk = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '改名前的会话' } });
  assert.equal(mk.status, 201);
  const sid = mk.body.session.id;

  const v = await call('PATCH', '/api/kernel/sessions/' + sid, { token: viewerToken, json: { title: 'x' } });
  assert.equal(v.status, 403, 'viewer 没有 session:write');

  const bad = await call('PATCH', '/api/kernel/sessions/' + sid, { token: adminToken, json: { title: '   ' } });
  assert.equal(bad.status, 400, '空标题必须被拒');

  const nf = await call('PATCH', '/api/kernel/sessions/ses-not-exist', { token: adminToken, json: { title: 'x' } });
  assert.equal(nf.status, 404);

  const r = await call('PATCH', '/api/kernel/sessions/' + sid, { token: adminToken, json: { title: '  改名后的会话  ' } });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.body.session.title, '改名后的会话', '标题要 trim');
  const list = await call('GET', '/api/kernel/sessions?limit=50', { token: adminToken });
  assert.ok((list.body.items || []).some((s) => s.id === sid && s.title === '改名后的会话'), '清单里要看到新标题');
});

await t('★ 会话删除：级联清事件/附件记录/产物记录/会话行；usage 台账保留；再删 404', async () => {
  const mk = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '待删除的会话' } });
  assert.equal(mk.status, 201);
  const sid = mk.body.session.id;

  // 一轮对话：产生事件 + usage 台账（usage_records）
  const turn = await call('POST', '/api/kernel/sessions/' + sid + '/turns', { token: adminToken, json: { content: '删除前的最后一句' } });
  assert.equal(turn.status, 200, turn.text.slice(0, 200));
  const eventsBefore = await call('GET', '/api/kernel/sessions/' + sid + '/events', { token: adminToken });
  assert.ok((eventsBefore.body.items || []).length > 0, '前置：会话里确实有事件');

  const v = await call('DELETE', '/api/kernel/sessions/' + sid, { token: viewerToken });
  assert.equal(v.status, 403, 'viewer 没有 session:write');

  const r = await call('DELETE', '/api/kernel/sessions/' + sid, { token: adminToken });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.body.deleted, true);
  assert.ok(r.body.cascaded.session === 1, '会话行要删掉');
  assert.ok(r.body.cascaded.events > 0, '事件要级联删掉');
  assert.ok(r.body.kept && r.body.kept.usageRecords,
    '诚实边界要写进响应：用量台账保留');

  const gone = await call('GET', '/api/kernel/sessions/' + sid, { token: adminToken });
  assert.equal(gone.status, 404, '删除后按 id 取是 404');
  const again = await call('DELETE', '/api/kernel/sessions/' + sid, { token: adminToken });
  assert.equal(again.status, 404, '再删一次也是 404');

  // usage 台账不随会话删除：全局用量汇总仍能查到这轮的数字
  const usage = await call('GET', '/api/governance/usage', { token: adminToken });
  assert.equal(usage.status, 200);
  assert.ok(usage.body.totals && Number(usage.body.totals.input) > 0, '配额与成本的依据（usage_records）必须还在');
});

/* ── 配额行内编辑 / 绑定判定切换（0.16.0）───────────────────────── */

await t('配额行内编辑：PUT 只改运行时字段；身份字段不生效；空补丁 400；不存在 404；viewer 403', async () => {
  const mk = await call('POST', '/api/governance/quotas', {
    token: adminToken, json: { subjectType: 'tenant', metric: 'turns', period: 'day', limitValue: 5, mode: 'block' },
  });
  assert.equal(mk.status, 201, mk.text.slice(0, 200));
  const qid = mk.body.id;
  assert.ok(qid, 'upsert 要回传 id（行内编辑要按 id 定位）');

  const v = await call('PUT', '/api/governance/quotas/' + qid, { token: viewerToken, json: { limitValue: 9 } });
  assert.equal(v.status, 403, 'viewer 没有 quota:write');

  const empty = await call('PUT', '/api/governance/quotas/' + qid, { token: adminToken, json: {} });
  assert.equal(empty.status, 400, '空补丁必须被拒（否则"点了保存"是个假动作）');

  const nf = await call('PUT', '/api/governance/quotas/qta-not-exist', { token: adminToken, json: { limitValue: 9 } });
  assert.equal(nf.status, 404);

  // 身份字段不在白名单里 —— 传了也不生效（改身份=删旧建新，页面也只放行运行时字段）
  const r = await call('PUT', '/api/governance/quotas/' + qid, {
    token: adminToken, json: { limitValue: 9, mode: 'warn', enabled: false, metric: 'input_tokens' },
  });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.deepEqual([...r.body.updated].sort(), ['enabled', 'limitValue', 'mode']);
  const list = await call('GET', '/api/governance/quotas', { token: adminToken });
  const row = (list.body.items || []).find((x) => x.id === qid);
  assert.equal(row.limitValue, 9);
  assert.equal(row.mode, 'warn');
  assert.equal(row.enabled, false);
  assert.equal(row.metric, 'turns', '身份字段（metric）不得被行内编辑改掉');
});

await t('绑定判定切换：PUT 翻转 allow；非布尔 400；不存在 404；viewer 403；tool 层已拒', async () => {
  // ⚠️ 0.21.10：这里原来用 `capabilityType: 'tool'` 做前置 —— 那是"工具是可治理能力"
  //    时代的写法。工具层已从 BINDING_LEVELS 去掉，接口现在会如实 400。
  //    改成一个**仍然存在**的层（server，MCP 服务名即绑定标识）。
  const mk = await call('POST', '/api/capability/bindings', {
    token: adminToken, json: { subjectType: 'tenant', capabilityType: 'server', capabilityId: 'stub.echo', allow: 0 },
  });
  assert.equal(mk.status, 200, mk.text.slice(0, 200));
  const bid = mk.body.binding.id;
  assert.equal(Number(mk.body.binding.allow), 0, '前置：deny 绑定');

  const v = await call('PUT', '/api/capability/bindings/' + bid, { token: viewerToken, json: { allow: true } });
  assert.equal(v.status, 403, 'viewer 没有 capability:write');

  const bad = await call('PUT', '/api/capability/bindings/' + bid, { token: adminToken, json: { allow: 'yes' } });
  assert.equal(bad.status, 400, 'allow 只收严格布尔（0/1/' + '"yes"' + ' 这类宽松值都会造成歧义）');

  const nf = await call('PUT', '/api/capability/bindings/cbp-not-exist', { token: adminToken, json: { allow: true } });
  assert.equal(nf.status, 404);

  const r = await call('PUT', '/api/capability/bindings/' + bid, { token: adminToken, json: { allow: true } });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(Number(r.body.binding.allow), 1, 'deny → allow 翻转生效');

  // 反向断言：`tool` 层不许被重新接受（0.21.10 删掉的不只是路由，还有这个值域）。
  // 服务端报的正是 `capability_type 只支持 connection/server/skill`。
  const tool = await call('POST', '/api/capability/bindings', {
    token: adminToken, json: { subjectType: 'tenant', capabilityType: 'tool', capabilityId: 'stub.echo', allow: 0 },
  });
  assert.equal(tool.status, 400, 'tool 层已从 BINDING_LEVELS 去掉，必须是 400 而不是悄悄接受');
});

/* ── 两步验证（TOTP，安全评审 §4.1）────────────────────────────── */

section('两步验证（TOTP）：真 HTTP 两步登录 / 恢复码 / 管理员重置 / 停用 / 重发');

/**
 * 现取现用：动作与取码相邻、步号单调上升，跨 30 秒边界时自适应（与 tools/test-core.mjs
 * 的 freshTotpCode 同一纪律 —— 每个用户在同一窗口内最多消费 2 个步号）。
 */
function httpFreshCode(secretBase32, lastUsed = null) {
  const now = totpStepAt();
  const step = Math.max(now, (lastUsed == null ? -1 : Number(lastUsed)) + 1);
  assert.ok(step - totpStepAt() <= TOTP_WINDOW,
    '测试自身动作跨出了 TOTP 窗口（step=' + step + '），重跑即可');
  return { code: hotp(base32Decode(secretBase32), step), step };
}

/** 一定错误的 6 位码：避开本密钥 ±2 步内的全部候选（服务器 ±1 窗口无论落哪都已排除） */
function httpWrongCode(secretBase32) {
  const s = totpStepAt();
  const taken = new Set([-2, -1, 0, 1, 2].map((d) => hotp(base32Decode(secretBase32), s + d)));
  for (let i = 0; ; i++) {
    const c = String(i).padStart(6, '0');
    if (!taken.has(c)) return c;
  }
}

// 本套回归跑到这里已有多个组织（见"附件与检索都不跨租户"一节建的隔离组织 C），
// 而登录解析目标组织时"多个则要求指明（不猜）"—— 所以下面一律显式指名主组织。
const mfaOrgSlug = (await call('GET', '/api/identity/setup')).body.setup.org.slug;

const MFA_A = { username: 'mfa_a', password: 'MfA-Pass!2345', orgSlug: mfaOrgSlug };
let mfaAId = null;
const mfaA = {};           // 跨用例保存：token0 / secret / c1 / recovery / lastSession

await t('登记第一步：状态接口不回显密钥；重输口令有守卫（错 401 / 对 200 出密钥与 otpauth URI）', async () => {
  const mk = await call('POST', '/api/identity/users', {
    token: adminToken,
    json: { username: MFA_A.username, password: MFA_A.password, displayName: '两步验证账号', roles: ['member'] },
  });
  assert.equal(mk.status, 201, mk.text.slice(0, 200));
  mfaAId = mk.body.user.id;

  // 未启用时：登录与从前逐字一致 —— 0.17.0 的硬边界，在 wire 上也钉住
  const login0 = await call('POST', '/api/identity/login', { json: MFA_A });
  assert.equal(login0.status, 200);
  assert.ok(login0.body.token && !('twoFactorRequired' in login0.body), '未启用账号的登录响应不得多出字段');
  mfaA.token0 = login0.body.token;

  const st0 = await call('GET', '/api/identity/totp', { token: mfaA.token0 });
  assert.equal(st0.status, 200);
  assert.equal(st0.body.totp.enabled, false);
  assert.equal(st0.body.totp.pending, false);
  assert.ok(!('secret' in st0.body.totp) && !('secret' in st0.body), '状态接口不得回显密钥');

  const wrongPw = await call('POST', '/api/identity/totp/enroll', {
    token: mfaA.token0, json: { password: 'Wrong-Pass!99' },
  });
  assert.equal(wrongPw.status, 401, '被偷的会话不能替受害者装第二因子（要求重输口令）');

  const ok = await call('POST', '/api/identity/totp/enroll', {
    token: mfaA.token0, json: { password: MFA_A.password },
  });
  assert.equal(ok.status, 200, ok.text.slice(0, 200));
  mfaA.secret = ok.body.enroll.secret;
  assert.match(mfaA.secret, /^[A-Z2-7]{32}$/, '20 字节 → 32 个 Base32 字符（验证器 App 手输友好）');
  assert.match(ok.body.enroll.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(ok.body.enroll.digits, 6);
  assert.equal(ok.body.enroll.periodSec, 30);

  const st1 = await call('GET', '/api/identity/totp', { token: mfaA.token0 });
  assert.equal(st1.body.totp.pending, true, '确认前只算 pending，不生效');
  assert.equal(st1.body.totp.enabled, false);
});

await t('确认登记：错码 400 且不启用；正确码启用 + 一批恢复码；管理员列表看得见 totpEnabled', async () => {
  const bad = await call('POST', '/api/identity/totp/confirm', {
    token: mfaA.token0, json: { code: httpWrongCode(mfaA.secret) },
  });
  assert.equal(bad.status, 400, bad.text.slice(0, 200));
  const stBad = await call('GET', '/api/identity/totp', { token: mfaA.token0 });
  assert.equal(stBad.body.totp.enabled, false, '错码不得把两步验证启用起来');

  mfaA.c1 = httpFreshCode(mfaA.secret);
  const ok = await call('POST', '/api/identity/totp/confirm', {
    token: mfaA.token0, json: { code: mfaA.c1.code },
  });
  assert.equal(ok.status, 200, ok.text.slice(0, 200));
  assert.equal(ok.body.enabled, true);
  assert.equal(ok.body.recoveryCodes.length, 10, '默认一批 10 张恢复码');
  for (const c of ok.body.recoveryCodes) assert.match(c, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  mfaA.recovery = ok.body.recoveryCodes;

  const st = await call('GET', '/api/identity/totp', { token: mfaA.token0 });
  assert.equal(st.body.totp.enabled, true);
  assert.equal(st.body.totp.recoveryCodesLeft, 10);

  const users = await call('GET', '/api/identity/users', { token: adminToken });
  assert.equal(users.body.users.find((u) => u.id === mfaAId).totpEnabled, true,
    '用户列表要给管理员"谁还裸奔"的视角');
});

await t('★ 两步登录（wire）：第一步只回一次性票据（不发 token/cookie）；错码/重放泛化 401；第二步才发会话', async () => {
  const s1 = await call('POST', '/api/identity/login', { json: MFA_A });
  assert.equal(s1.status, 200, s1.text.slice(0, 200));
  assert.equal(s1.body.twoFactorRequired, true);
  assert.ok(String(s1.body.ticket).startsWith('stc_'), '票据有独立前缀（与会话 sti_ / API Key stik_ 无包含关系）');
  assert.ok(!s1.body.token, '第一步不得发会话令牌');
  assert.equal(cookiePair(s1.setCookies), null, '第一步不得下发会话 cookie');
  assert.ok(s1.body.expiresAt, '票据要带过期时间');

  const badTicket = await call('POST', '/api/identity/login/totp', {
    json: { ticket: 'not-a-ticket', code: '123456' },
  });
  assert.equal(badTicket.status, 401, '票据格式不符 → 泛化 401');

  const wrong = await call('POST', '/api/identity/login/totp', {
    json: { ticket: s1.body.ticket, code: httpWrongCode(mfaA.secret) },
  });
  assert.equal(wrong.status, 401, '错码 → 同一句泛化 401');
  assert.equal(wrong.body.error.message, badTicket.body.error.message,
    '"票据坏"与"码错"的文案必须一致 —— 否则探测器能分辨走到哪一步');

  const replay = await call('POST', '/api/identity/login/totp', {
    json: { ticket: s1.body.ticket, code: mfaA.c1.code },
  });
  assert.equal(replay.status, 401, '确认登记时用过的码不能再拿去登录（防重放贯穿两处）');

  const s2 = await call('POST', '/api/identity/login', { json: MFA_A });
  assert.notEqual(s2.body.ticket, s1.body.ticket, '新登录发新票据');
  const c2 = httpFreshCode(mfaA.secret, mfaA.c1.step);
  const ok = await call('POST', '/api/identity/login/totp', {
    json: { ticket: s2.body.ticket, code: c2.code },
  });
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  assert.ok(ok.body.token && ok.body.user.username === MFA_A.username);
  assert.ok(!('twoFactorRequired' in ok.body), '第二步完成就是完整登录响应');
  assert.ok(cookiePair(ok.setCookies), '第二步完成才下发会话 cookie');
  assert.equal((await call('GET', '/api/identity/me', { token: ok.body.token })).status, 200,
    '第二步的会话必须立刻可用');

  const reuse = await call('POST', '/api/identity/login/totp', {
    json: { ticket: s2.body.ticket, code: c2.code },
  });
  assert.equal(reuse.status, 401, '已消费票据不得复用（票据一次性）');
});

await t('恢复码（wire）：use 一次剩 9；同张再试 401；大小写/分隔符容错后仍是同一张', async () => {
  const s3 = await call('POST', '/api/identity/login', { json: MFA_A });
  const rec = mfaA.recovery[0];
  const ok = await call('POST', '/api/identity/login/totp', { json: { ticket: s3.body.ticket, code: rec } });
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  assert.equal(ok.body.viaRecoveryCode, true);
  assert.equal(ok.body.recoveryCodesLeft, 9, '成功响应回带剩余恢复码数（界面据此提示"该重新生成一批了"）');
  assert.equal((await call('GET', '/api/identity/me', { token: ok.body.token })).status, 200);

  const s4 = await call('POST', '/api/identity/login', { json: MFA_A });
  const again = await call('POST', '/api/identity/login/totp', { json: { ticket: s4.body.ticket, code: rec } });
  assert.equal(again.status, 401, '恢复码一次性：同一张不能完成第二次登录');

  // 抄写容错：登记时给出的码换成小写 + 空格分隔 + 前后空白，归一化后是同一张
  const s5 = await call('POST', '/api/identity/login', { json: MFA_A });
  const messy = ' ' + mfaA.recovery[1].toLowerCase().replace('-', ' ') + ' ';
  const ok2 = await call('POST', '/api/identity/login/totp', { json: { ticket: s5.body.ticket, code: messy } });
  assert.equal(ok2.status, 200, '大小写/分隔符差异不构成"码错了"');
  assert.equal(ok2.body.recoveryCodesLeft, 8);
  mfaA.lastSession = ok2.body.token;
});

await t('管理员重置（wire）：清第二因子 + 未完成票据；口令/会话不动；用户回单步登录', async () => {
  const v = await call('POST', '/api/identity/users/' + mfaAId + '/totp-reset', { token: viewerToken });
  assert.equal(v.status, 403, 'viewer 没有 user:write');

  // 留一张未完成的第二步票据 —— 重置必须把它一并作废
  const pend = await call('POST', '/api/identity/login', { json: MFA_A });
  assert.equal(pend.body.twoFactorRequired, true);

  const r = await call('POST', '/api/identity/users/' + mfaAId + '/totp-reset', { token: adminToken });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.body.hadTotp, true);
  assert.equal(r.body.codesRemoved, 10, '恢复码整表清空（用过的 + 未用的，共 10 行）');
  assert.equal(r.body.challengesInvalidated, 1, '未完成的那张第二步票据作废');

  const st = await call('GET', '/api/identity/totp', { token: mfaA.lastSession });
  assert.equal(st.body.totp.enabled, false, '重置后第二因子清空');
  assert.equal((await call('GET', '/api/identity/me', { token: mfaA.lastSession })).status, 200,
    '重置不动会话（轻处置；更强处置是重置口令）');

  const single = await call('POST', '/api/identity/login', { json: MFA_A });
  assert.equal(single.status, 200);
  assert.ok(single.body.token && !('twoFactorRequired' in single.body), '回单步：登录不再要第二步');

  const dead = await call('POST', '/api/identity/login/totp', { json: { ticket: pend.body.ticket, code: '000000' } });
  assert.equal(dead.status, 401, '重置后旧票据已作废');
});

await t('停用（wire）：错码 400 / 错口令 401 / 双证齐 → 200；停用即回单步账号', async () => {
  const U = { username: 'mfa_b', password: 'MfB-Pass!2345', orgSlug: mfaOrgSlug };
  const mk = await call('POST', '/api/identity/users', {
    token: adminToken, json: { username: U.username, password: U.password, displayName: '停用两步', roles: ['member'] },
  });
  assert.equal(mk.status, 201, mk.text.slice(0, 200));
  const tk = (await call('POST', '/api/identity/login', { json: U })).body.token;
  const en = await call('POST', '/api/identity/totp/enroll', { token: tk, json: { password: U.password } });
  const secret = en.body.enroll.secret;
  const c1 = httpFreshCode(secret);
  const conf = await call('POST', '/api/identity/totp/confirm', { token: tk, json: { code: c1.code } });
  assert.equal(conf.status, 200, conf.text.slice(0, 200));

  const bad = await call('POST', '/api/identity/totp/disable', {
    token: tk, json: { password: U.password, code: httpWrongCode(secret) },
  });
  assert.equal(bad.status, 400, '码不对 → 400（校验问题，不是凭证问题）');
  const badPw = await call('POST', '/api/identity/totp/disable', {
    token: tk, json: { password: 'Wrong-Pass!99', code: httpWrongCode(secret) },
  });
  assert.equal(badPw.status, 401, '口令不对 → 401');

  const c2 = httpFreshCode(secret, c1.step);
  const off = await call('POST', '/api/identity/totp/disable', {
    token: tk, json: { password: U.password, code: c2.code },
  });
  assert.equal(off.status, 200, off.text.slice(0, 200));
  assert.equal(off.body.enabled, false);
  assert.equal((await call('GET', '/api/identity/totp', { token: tk })).body.totp.enabled, false);

  const single = await call('POST', '/api/identity/login', { json: U });
  assert.ok(single.body.token && !('twoFactorRequired' in single.body), '停用即回单步账号（恢复码与票据一并清）');
});

await t('重发恢复码（wire）：只认动态码；旧批整批作废、新批一次性可用', async () => {
  const U = { username: 'mfa_c', password: 'MfC-Pass!2345', orgSlug: mfaOrgSlug };
  const mk = await call('POST', '/api/identity/users', {
    token: adminToken, json: { username: U.username, password: U.password, displayName: '重发恢复码', roles: ['member'] },
  });
  assert.equal(mk.status, 201, mk.text.slice(0, 200));
  const tk = (await call('POST', '/api/identity/login', { json: U })).body.token;
  const en = await call('POST', '/api/identity/totp/enroll', { token: tk, json: { password: U.password } });
  const secret = en.body.enroll.secret;
  const c1 = httpFreshCode(secret);
  const conf = await call('POST', '/api/identity/totp/confirm', { token: tk, json: { code: c1.code } });
  const oldCodes = conf.body.recoveryCodes;

  const viaOld = await call('POST', '/api/identity/totp/recovery-codes', { token: tk, json: { code: oldCodes[0] } });
  assert.equal(viaOld.status, 400, '恢复码不能自我续命 —— 重发只认动态码');

  const c2 = httpFreshCode(secret, c1.step);
  const regen = await call('POST', '/api/identity/totp/recovery-codes', { token: tk, json: { code: c2.code } });
  assert.equal(regen.status, 200, regen.text.slice(0, 200));
  assert.equal(regen.body.recoveryCodes.length, 10);
  assert.equal(new Set(regen.body.recoveryCodes).size, 10, '新批之内不得重复');
  assert.equal(regen.body.recoveryCodes.filter((c) => oldCodes.includes(c)).length, 0,
    '新批不得与旧批有交集（40 位熵，撞了就是生成出了问题）');

  const s1 = await call('POST', '/api/identity/login', { json: U });
  const dead = await call('POST', '/api/identity/login/totp', { json: { ticket: s1.body.ticket, code: oldCodes[1] } });
  assert.equal(dead.status, 401, '旧批在重发那一刻整批作废');
  const s2 = await call('POST', '/api/identity/login', { json: U });
  const ok = await call('POST', '/api/identity/login/totp', {
    json: { ticket: s2.body.ticket, code: regen.body.recoveryCodes[0] },
  });
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  assert.equal(ok.body.recoveryCodesLeft, 9);
});

/* ── 工作区树与三档权限（0.21.0）────────────────────────────────────── */
section('工作区树：CRUD / 全组织可见 / 档位按组织角色 / 会话归位 / 模式与推理等级');

/**
 * 本段**自带两个探针账号**，刻意不借前面各段留下的 `viewerToken`。
 * 理由：TOTP 段可能给某个账号启用过第二因子，而"某个旧令牌在这一段还能不能用"
 * 不该由本段来赌 —— 段与段之间的隐式依赖正是回归最容易腐化的地方。
 *
 * 两个账号的**全局角色**差异是本段的关键（0.21.6 起档位只按组织角色推导）：
 *   · 探针 A（viewer）：全局只读 → 连 `session:write` 都没有，路由层的门就把它挡了；
 *   · 探针 B（member）：全局可写 → 能一路走到服务层的档位判定，
 *     于是"**档位**不够"这件事才第一次真的可被观测到（403 来自服务层而非 rbac）。
 *     ⚠️ 只用 viewer 验，验到的是 RBAC 而不是档位 —— 那些用例会**永远绿**，却什么也没钉住。
 */
const wsxStamp = Date.now().toString(36).slice(-6);
const wsxAccA = { username: 'wsx-view-' + wsxStamp, password: 'Wsx-View-Pass!23' };
const wsxAccB = { username: 'wsx-mem-' + wsxStamp, password: 'Wsx-Mem-Pass!23' };
let wsxAId = null;
let wsxBId = null;
let wsxAToken = null;
let wsxBToken = null;
let wsxOpenId = null;        // 探针工作区（纯组织容器）
let wsxLockedId = null;      // 第二个工作区（判"全组织可见"与档位的场地）
let wsxLockedSession = null; // 管理员建在第二个工作区里的会话
let wsxProbeSession = null;  // 探针 B 用 write 档建的会话

await t('工作区探针账号：管理员建档（viewer / member 各一）+ 各自登录，本段自包含', async () => {
  const ra = await call('POST', '/api/identity/users', {
    token: adminToken,
    json: { username: wsxAccA.username, password: wsxAccA.password, displayName: '工作区探针A', roles: ['viewer'] },
  });
  assert.equal(ra.status, 201, JSON.stringify(ra.body));
  assert.ok(ra.body.user.roles.includes('viewer'), '探针 A 要是全局只读');
  wsxAId = ra.body.user.id;

  const rb = await call('POST', '/api/identity/users', {
    token: adminToken,
    json: { username: wsxAccB.username, password: wsxAccB.password, displayName: '工作区探针B', roles: ['member'] },
  });
  assert.equal(rb.status, 201, JSON.stringify(rb.body));
  assert.ok(rb.body.user.roles.includes('member'), '探针 B 要是全局可写');
  wsxBId = rb.body.user.id;

  assert.notEqual(wsxAId, wsxBId,
    '两个探针必须是不同的账号 —— 用户名撞了（同一个 stamp）会变成同一个人的两次观测，'
    + '后面所有"不同角色给出不同结论"的对照都会失去意义');

  // ⚠️ 登录必须指明组织。本段跑在最末，前面的"多租户隔离"用例已经建了**第二个组织**，
  //    此时 `identity.login({username})` 会如实拒绝（"存在多个组织，请指明组织"）——
  //    那个 400 是对的，不是缺陷；这里该做的是把组织带上。
  //    组织标识从**公开的初始化状态**取（登录页本来就要显示它），再拿 admin 的 orgId 对账一次：
  //    万一取到了别的组织，这里会立刻红，而不是安静地在另一个租户里跑完本段。
  const st = await call('GET', '/api/identity/setup');
  const orgSlug = st.body.setup && st.body.setup.org ? st.body.setup.org.slug : null;
  assert.ok(orgSlug, '要拿得到组织标识（多组织部署下登录必须指明组织）');
  const adminMe = await call('GET', '/api/identity/me', { token: adminToken });
  const orgId = adminMe.body.user.orgId;

  const la = await call('POST', '/api/identity/login', { json: { ...wsxAccA, orgSlug } });
  assert.equal(la.status, 200, JSON.stringify(la.body));
  assert.ok(!la.body.twoFactorRequired, '新建账号不该带第二因子（带上了说明本段的前置假设不成立）');
  assert.equal(la.body.user.orgId, orgId, '探针必须落在同一个组织里，否则本段在测别的租户');
  wsxAToken = la.body.token;

  const lb = await call('POST', '/api/identity/login', { json: { ...wsxAccB, orgSlug } });
  assert.equal(lb.status, 200, JSON.stringify(lb.body));
  assert.ok(!lb.body.twoFactorRequired, '同上');
  assert.equal(lb.body.user.orgId, orgId);
  wsxBToken = lb.body.token;
});

await t('路由表登记了工作区的 5 条接口与模式端点（少挂只表现为 404，比启动失败更难查）', async () => {
  const r = await call('GET', '/api/system/routes');
  assert.equal(r.status, 200);
  const ids = new Set(r.body.routes.map((x) => x.id));
  for (const id of ['workspace.tree', 'workspace.create', 'workspace.update', 'workspace.delete',
    'workspace.browse', 'kernel.presets']) {
    assert.ok(ids.has(id), '路由表里少了 ' + id);
  }
  const ws = r.body.routes.filter((x) => x.id.startsWith('workspace.'));
  // 4 条是 0.21.0 的树/建/改/删（0.21.6 删掉了 3 条授权端点），第 5 条是 0.21.7 加的目录列举。
  assert.equal(ws.length, 5, '工作区路由应恰好 5 条（0.21.6 删掉 3 条授权端点、0.21.7 加了目录列举），实际 ' + ws.length);
  const byId = Object.fromEntries(ws.map((x) => [x.id, x]));
  const rest = ws.filter((x) => x.id !== 'workspace.browse');
  assert.ok(rest.every((x) => x.milestone === '0.21.0'), '其余四条仍是 0.21.0 的接口');
  assert.equal(byId['workspace.browse'].milestone, '0.21.7', '目录列举是 0.21.7 加的');
  // 新增一条路由要连**声明面**一起钉（方法 / 档位 / 权限键）：写错时路由仍在表里，
  // 但语义已经错了 —— 只查 id 查不出来。
  assert.equal(byId['workspace.browse'].method, 'GET', '目录列举是**只读**的 —— 只能是 GET');
  assert.equal(byId['workspace.browse'].scope, 'session');
  assert.deepEqual(byId['workspace.browse'].capability, ['session:write'],
    '门槛必须与 workspace.create **完全一致**（都是 session:write）：能建工作区的人本来就'
    + '能把 cwd 填成服务器上任意一处，本接口只把"盲填路径"变成"看得见地选"，不增加任何能力 —— '
    + '它因此不该、也不需要另一档权限。');
  // 反向断言：授权端点不许回来。删它们不是"暂时下线"—— 上游 dsh 自己有一份工作区权限，
  // 而平台没有接口去改那一份；留着这三个端点就等于留着一份改了不生效的权限真相（见迁移 0023）。
  assert.ok(![...ids].some((x) => x.startsWith('workspace.grants.')),
    '授权端点已随工作区权限模块删除，不该再出现：'
    + [...ids].filter((x) => x.startsWith('workspace.')).join(' / '));
});

await t('目录列举：只列子目录、路径先 realpath 归一、读不了与不存在分开报、有上限并如实标截断', async () => {
  // 这条钉的是 browse 的**安全边界**（见 app/platform/workspace/browse.mjs 头注释）：
  // 它把"盲填服务器路径"变成"看得见地选"，所以边界写歪了就是一次目录探测的便利化。
  const anon = await call('GET', '/api/workspaces/browse');
  assert.equal(anon.status, 401, '未登录应 401');
  const noWrite = await call('GET', '/api/workspaces/browse', { token: viewerToken });
  assert.equal(noWrite.status, 403, '门槛与 create 同一档（session:write）—— 只有查看权限的角色应 403');

  const ok = await call('GET', '/api/workspaces/browse', { token: adminToken });
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  assert.ok(typeof ok.body.path === 'string' && ok.body.path, '要回**归一后**的路径（不是请求原样）');
  assert.ok(Array.isArray(ok.body.entries), 'entries 要是数组');
  assert.ok(Array.isArray(ok.body.roots) && ok.body.roots.length >= 1, '要给常用起点');
  // ★ 反向（0.21.9，用户裁定「工作目录那一节去掉平台数据目录、平台安装目录」）：
  //   判据用**路径**而不是标签 —— 标签是文案（会改），"起点里有没有平台自己的家"
  //   才是这件事的事实。摆成"常用"等于一个诱导：选中之后上游项目级能力就能在
  //   平台自己的数据库/日志/密钥/源码上读写。它们仍未被禁掉（`workspace.create`
  //   照旧接受任意 cwd），只是不再**推荐**。
  {
    const rootPaths = ok.body.roots.map((r) => r.path);
    assert.ok(!rootPaths.includes(DATA_DIR), '常用起点里不许再出现平台数据目录：' + JSON.stringify(rootPaths));
    assert.ok(!rootPaths.includes(ROOT), '也不许出现平台安装目录：' + JSON.stringify(rootPaths));
  }
  assert.ok(ok.body.entries.every((e) => typeof e.name === 'string' && typeof e.path === 'string'),
    '每项要有 name 与 path');
  // ★ 只列**目录**：不能把文件也倒出来 —— 选择器的用途是挑一个工作目录，文件列表在这里没有用。
  //   判据用"每个 entry 都真的是目录"（正面验证），而不是"响应里没有某个文件名"。
  for (const e of ok.body.entries) {
    assert.ok(fs.statSync(e.path).isDirectory(), '列举里混进了非目录：' + e.path);
  }
  // 不递归：一次只走一层（因此不存在符号链接成环导致遍历失控的问题）
  assert.ok(!Object.prototype.hasOwnProperty.call(ok.body, 'children'), '不该有递归结构');

  // realpath 归一：`..` 要先被解析掉，不能拿它当"跳过一层校验"的通道
  const dotdot = await call('GET', '/api/workspaces/browse?path=' + encodeURIComponent(ok.body.path + '/../..'),
    { token: adminToken });
  assert.equal(dotdot.status, 200);
  const realOf = fs.realpathSync(ok.body.path + '/../..');
  assert.equal(dotdot.body.path, realOf, '`..` 必须被 realpath 归一（否则"越过一层"就成了特征）');

  // 不存在 / 不是目录 → 404；读不了 → 400（两者**必须分开**：混成一个码会让用户
  // 去建一个其实已经存在的目录，或者以为目录没了）
  const missing = await call('GET', '/api/workspaces/browse?path=' + encodeURIComponent(ok.body.path + '/__no_such_dir__'),
    { token: adminToken });
  assert.equal(missing.status, 404, '目录不存在应 404，实际 ' + missing.status + '：' + missing.text.slice(0, 200));
  // 给一个**文件**路径（不是目录）也要 404 —— ENOTDIR 与 ENOENT 归同一类"你要的东西不在那儿"。
  // ⚠️ 用 import.meta.url 推文件绝对路径，不用 __filename：本文件是 ESM，没有 __filename。
  const aFile = fs.realpathSync(new URL('../VERSION', import.meta.url));
  const notDir = await call('GET', '/api/workspaces/browse?path=' + encodeURIComponent(aFile),
    { token: adminToken });
  assert.equal(notDir.status, 404, '给一个文件路径应 404（ENOTDIR），实际 ' + notDir.status);
  // 读不了的那一条（EACCES）依赖运行账号的权限，跨平台不可靠 —— 这里只钉**码的分工**：
  // 上面两条已经证明"不存在类错误 → 404"；400 的分支由 browse.mjs 里那条 badRequest 兜住。
});

await t('工作区树与模式端点：未登录 401；树只给组织容器的事实，不再下发档位与授权名单', async () => {
  for (const p of ['/api/workspaces', '/api/kernel/presets']) {
    const anon = await call('GET', p);
    assert.equal(anon.status, 401, p + ' 未登录应 401，实际 ' + anon.status);
  }

  // 模式：平台**不发明**内核没有的模式 —— 清单直接来自内核，测试替身 与真机同构
  const presets = await call('GET', '/api/kernel/presets', { token: adminToken });
  assert.equal(presets.status, 200, JSON.stringify(presets.body));
  assert.deepEqual(presets.body.presets.map((p) => p.id), ['standard', 'ptc', 'minimal', 'cordis']);
  assert.deepEqual(presets.body.presets.map((p) => p.isDefault), [true, false, false, false]);

  const tree = await call('GET', '/api/workspaces', { token: adminToken });
  assert.equal(tree.status, 200, JSON.stringify(tree.body));
  assert.ok(Array.isArray(tree.body.items), '树要给出工作区清单');
  // ★ 0.21.9：「未分组」这个桶整个删了（用户裁定）。树不再下发 `ungroupedCount`，
  //   换成"哪一个是兜底工作区" —— 前端要靠 `isDefault` / `defaultWorkspaceId` 做两件事：
  //   那一行不摆"重命名 / 删除"（摆了点了必然 403，读起来像产品坏了），
  //   以及删工作区的确认语里说清"会话会移进「默认工作区」"时那个名字是哪来的。
  assert.equal(tree.body.ungroupedCount, undefined, '树不该再下发 ungroupedCount（那个桶已不存在）');
  assert.equal(typeof tree.body.defaultWorkspaceId, 'string', '要如实给出兜底工作区的 id（删工作区的会话落点）');
  const defRows = tree.body.items.filter((w) => w.isDefault);
  assert.equal(defRows.length, 1, '每个租户恰好一条兜底工作区（服务层维持的不变量），实际 '
    + defRows.length + ' 条：' + JSON.stringify(tree.body.items.map((w) => [w.name, !!w.isDefault])));
  assert.equal(tree.body.defaultWorkspaceId, defRows[0].id, 'defaultWorkspaceId 指的就是 isDefault 那一条');
  // ★ 反向断言：档位展示名与授权角色清单都已删。留着它们，前端就有东西可渲染 ——
  //   而那块界面（工作区权限三档）正是 0.21.6 整块删掉的：上游有一份、平台改不动。
  for (const k of ['levelLabels', 'grantRoles']) {
    assert.equal(tree.body[k], undefined, '树不该再下发 ' + k + '（工作区权限模块已删，见迁移 0023）');
  }
  for (const it of tree.body.items) {
    assert.equal(it.myLevel, undefined, '工作区对自己可见 —— 但不下发 myLevel（那是已删除的档位界面用的）');
  }
});

await t('工作区 CRUD：空名 400、不存在 404；改工作区要完全权限（member 得 403，不是 404）', async () => {
  const created = await call('POST', '/api/workspaces', {
    token: adminToken,
    json: { name: '回归工作区', cwd: '/tmp/sti-wsx-open', description: '回归用' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.workspace.ownerUserId, '建档人要落库');
  // ★ 反向断言：工作区是**纯组织容器**，没有 `visibility` 了。
  //   迁移 0023 把列删掉，路由也不再收这个入参 —— 一份"存下来但不生效"的可见性比没有更糟。
  assert.ok(!('visibility' in created.body.workspace),
    'workspace 回执里不该再有 visibility（迁移 0023 已删列），实际字段：'
    + Object.keys(created.body.workspace).join(' / '));
  wsxOpenId = created.body.workspace.id;

  const bad = await call('POST', '/api/workspaces', { token: adminToken, json: { name: '   ' } });
  assert.equal(bad.status, 400, '空名应当是 400，实际 ' + bad.status);

  const tree = await call('GET', '/api/workspaces', { token: adminToken });
  const me = tree.body.items.find((w) => w.id === wsxOpenId);
  assert.ok(me, '刚建的工作区必须出现在树里');
  assert.equal(me.sessionCount, 0, '新工作区里没有会话');
  assert.equal(me.cwd, '/tmp/sti-wsx-open', 'cwd 要回显 —— 它是工作区最重要的属性，也是会话 cwd 的来源');

  const renamed = await call('PATCH', '/api/workspaces/' + wsxOpenId, {
    token: adminToken, json: { name: '回归工作区（改名）', description: '改过了' },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.workspace.name, '回归工作区（改名）', '改名要真落库，不是把我们发出去的值复述一遍');

  const emptyName = await call('PATCH', '/api/workspaces/' + wsxOpenId, { token: adminToken, json: { name: '' } });
  assert.equal(emptyName.status, 400, '空名是 400，实际 ' + emptyName.status);

  // cwd 超长必须封顶：它会原样交给上游当项目根，长度不封顶就是一条通往上游参数的注入边
  const longCwd = await call('PATCH', '/api/workspaces/' + wsxOpenId, {
    token: adminToken, json: { cwd: 'x'.repeat(513) },
  });
  assert.equal(longCwd.status, 400, 'cwd 超长应为 400，实际 ' + longCwd.status);

  const missing = await call('PATCH', '/api/workspaces/wsp_does_not_exist', { token: adminToken, json: { name: 'x' } });
  assert.equal(missing.status, 404, '不存在的工作区是 404，不是 500');
  assert.equal(missing.body.error.code, 'not_found');

  // ★ 档位不够必须是 403，**不是** 404。工作区现在对全组织可见，
  //   404 在这里只剩"真的没有这个 id"一种含义 —— "看不见就 404"那条随可见性一起删了。
  //   探针 B 是全局 member（write 档），改工作区要 full —— 请求能走到服务层，然后被档位拒绝。
  const byB = await call('PATCH', '/api/workspaces/' + wsxOpenId, {
    token: wsxBToken, json: { name: '探针B改名' },
  });
  assert.equal(byB.status, 403, 'write 档改工作区应是 403，实际 ' + byB.status);
  assert.match(byB.body.error.message, /工作区内修改/, '理由要点名当前档位：' + JSON.stringify(byB.body));
  assert.match(byB.body.error.message, /完全权限/, '并说清需要哪一档');
});

await t('工作区对全组织可见；档位不够是 403（不是 404）；授权端点已从路由表上消失', async () => {
  const created = await call('POST', '/api/workspaces', {
    token: adminToken, json: { name: '第二个工作区', cwd: '/tmp/sti-wsx-locked' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  wsxLockedId = created.body.workspace.id;

  const ses = await call('POST', '/api/kernel/sessions', {
    token: adminToken, json: { title: '第二个区里的会话', workspaceId: wsxLockedId },
  });
  assert.equal(ses.status, 201, JSON.stringify(ses.body));
  wsxLockedSession = ses.body.session.id;
  assert.equal(ses.body.session.workspaceId, wsxLockedId, '会话要真的挂在工作区上（回显落库值）');

  // cwd 继承工作区：工作区是会话的组织容器，cwd 是它最重要的属性（与原生 Harness 同语义）
  const detail = await call('GET', '/api/kernel/sessions/' + wsxLockedSession, { token: adminToken });
  assert.equal(detail.body.session.cwd, '/tmp/sti-wsx-locked', '未显式给 cwd 时应继承工作区的');

  const adminTree = await call('GET', '/api/workspaces', { token: adminToken });
  const mine = adminTree.body.items.find((w) => w.id === wsxLockedId);
  assert.ok(mine, '工作区要在树里');
  assert.equal(mine.sessionCount, 1, '会话数要按工作区归集');

  // ★ 全组织可见（0.21.6 的语义变化）：任何有 session:read 的角色都看得见它、也读得到里面的会话。
  //   从前受限工作区对未授权者是"根本不出现 + 一律 404"，那条随可见性一起删了。
  for (const [who, token] of [['探针A(viewer)', wsxAToken], ['探针B(member)', wsxBToken]]) {
    const t1 = await call('GET', '/api/workspaces', { token });
    assert.ok(t1.body.items.some((w) => w.id === wsxLockedId),
      who + ' 应当看得见工作区 —— 它现在是全组织可见的组织容器，不是权限载体');

    const t2 = await call('GET', '/api/kernel/sessions?limit=200', { token });
    assert.ok(t2.body.items.some((s) => s.id === wsxLockedSession),
      who + ' 的会话列表里也应当有它 —— 会话的可见性跟着工作区走');

    const t3 = await call('GET', '/api/kernel/sessions/' + wsxLockedSession, { token });
    assert.equal(t3.status, 200, who + ' 读工作区里的会话应是 200，实际 ' + t3.status);
  }

  // ★ 写路径：档位不够是 **403**，理由点名档位 —— 不再用 404 掩盖存在性。
  const t4 = await call('PATCH', '/api/workspaces/' + wsxLockedId, { token: wsxBToken, json: { name: '我改' } });
  assert.equal(t4.status, 403, 'write 档改工作区应是 403（不是 404），实际 ' + t4.status);

  // ★ 三个授权端点已不在路由表上 → 一律 404，**对管理员也一样**
  //   （若只是"没权限"，管理员会拿到 200/403；404 才证明端点真的没了）
  const g = await call('GET', '/api/workspaces/' + wsxLockedId + '/grants', { token: adminToken });
  assert.equal(g.status, 404, '授权名单端点已删，管理员访问也应 404，实际 ' + g.status);
});

await t('档位只按组织角色推导：viewer = 仅可查看（读得到、建不了、改不了）', async () => {
  // 档位的**唯一**来源是组织角色（见 platform/workspace/visibility.mjs 的 levelFromRoles：
  // full ← session:delete、write ← session:execute、view ← session:read、未知 → none）。
  // 从前还要把"在这个工作区上被授了什么"并进来，那一层随工作区权限模块一起删了（迁移 0023）。

  const read = await call('GET', '/api/kernel/sessions/' + wsxLockedSession, { token: wsxAToken });
  assert.equal(read.status, 200, 'view 档能读会话，实际 ' + read.status);

  // 建会话：被**路由层的 RBAC** 挡住（viewer 连全局 session:write 都没有）
  const create = await call('POST', '/api/kernel/sessions', {
    token: wsxAToken, json: { title: '探针A想建的', workspaceId: wsxLockedId },
  });
  assert.equal(create.status, 403, 'view 档不能建会话，实际 ' + create.status);
  assert.deepEqual(create.body.error.detail.needs, ['session:write'], '挡住它的是租户级能力，不是工作区档位');

  // 改工作区：路由层只把 `session:read`（viewer 有），所以这条**真的走到了工作区层**，
  // 由 `assertWorkspaceAccess` 按档位拒绝 —— 这条才是"档位有牙齿"的证据。
  const patch = await call('PATCH', '/api/workspaces/' + wsxLockedId, { token: wsxAToken, json: { name: '探针A改名' } });
  assert.equal(patch.status, 403, 'view 档不能改工作区，实际 ' + patch.status);
  assert.match(patch.body.error.message, /仅可查看/, '拒绝理由要说清当前档位：' + JSON.stringify(patch.body));
});

await t('档位：member = 工作区内修改（建得了会话、发得了回合，改不了工作区）；admin = 完全权限', async () => {
  // ② write 档：能建会话、能发回合
  const create = await call('POST', '/api/kernel/sessions', {
    token: wsxBToken, json: { title: '探针B建的会话', workspaceId: wsxLockedId },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  wsxProbeSession = create.body.session.id;
  assert.equal(create.body.session.workspaceId, wsxLockedId);
  // 建会话的回执不带 cwd（它不是"刚发生的事"，是既有属性）—— 要去详情里读。
  // 这里要钉的是"member 建的会话也照常继承工作区 cwd"，与上一段管理员那条同一个结论、不同角色。
  const created = await call('GET', '/api/kernel/sessions/' + wsxProbeSession, { token: wsxBToken });
  assert.equal(created.body.session.cwd, '/tmp/sti-wsx-locked', '新会话要继承工作区的 cwd');

  const turn = await call('POST', '/api/kernel/sessions/' + wsxProbeSession + '/turns', {
    token: wsxBToken, json: { content: '本轮用来证明 write 档能发回合' },
  });
  assert.equal(turn.status, 200, JSON.stringify(turn.body));
  assert.ok(turn.body.eventsWritten > 0, '测试替身要真的回了事件');

  // ③ write 档仍**不是**完全权限 —— 这条 403 来自服务层（路由层只把 session:read，member 有）
  const still = await call('PATCH', '/api/workspaces/' + wsxLockedId, {
    token: wsxBToken, json: { name: '还是不给我改' },
  });
  assert.equal(still.status, 403, 'write 档改不了工作区，实际 ' + still.status);
  assert.match(still.body.error.message, /需要：完全权限/, '理由要点名缺哪个档：' + JSON.stringify(still.body));

  // ④ full 档（管理员的 `session:delete` 就是它）：改得动，且改完真落库
  const nowOk = await call('PATCH', '/api/workspaces/' + wsxLockedId, {
    token: adminToken, json: { description: '有了完全权限才能改' },
  });
  assert.equal(nowOk.status, 200, JSON.stringify(nowOk.body));
  assert.equal(nowOk.body.workspace.description, '有了完全权限才能改');

  // ★ 反证：同一个动作换**不同的组织角色**得到不同结果 —— 这正是"档位按组织角色推导"的意思。
  //   没有这条，上面那些 403 也可能只是路由层挡住了，档位根本没参与判定。
  const reread = await call('GET', '/api/workspaces', { token: wsxBToken });
  assert.equal(reread.body.items.find((w) => w.id === wsxLockedId).sessionCount, 2,
    '两个会话都在这个工作区里（管理员一个、探针 B 一个）');
});

await t('会话归位：移动必须给出目标（空值 400）；删工作区**不级联** —— 会话落进默认工作区', async () => {
  // 0.21.9 口径变了（用户裁定：「删除未分组，删除工作区的会话落入默认工作区」）：
  //   · **没有"移出到未分组"这回事了** —— `workspaceId` 空值直接 400，不再有一条
  //     "置空即移出"的路（那个桶整个不存在了）；
  //   · 删工作区时会话的去处从"未分组"改成**兜底工作区**，回执因此给的是
  //     `movedSessions` / `toWorkspaceId` / `toWorkspaceName`（不再是 `detachedSessions`）。
  const b0 = await call('GET', '/api/workspaces', { token: adminToken });
  const defId = b0.body.defaultWorkspaceId;
  assert.ok(defId, '要有兜底工作区，否则这条用例没法谈"落点"');
  const defBefore = b0.body.items.find((w) => w.id === defId).sessionCount;

  // 移进开放工作区（目标档位够即可；移别人的会话还要源侧的 full —— 管理员两者都有）
  const moved = await call('PATCH', '/api/kernel/sessions/' + wsxLockedSession, {
    token: adminToken, json: { title: '受限区里的会话', workspaceId: wsxOpenId },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.session.workspaceId, wsxOpenId, '移动要真落库并回显落库值');

  const t1 = await call('GET', '/api/workspaces', { token: adminToken });
  assert.equal(t1.body.items.find((w) => w.id === wsxOpenId).sessionCount, 1, '目标工作区会话数 +1');
  assert.equal(t1.body.items.find((w) => w.id === wsxLockedId).sessionCount, 1, '源工作区只剩探针 B 那个');

  // ★ 空目标 = 400。为什么不悄悄塞进默认工作区：用户点的是"移动到…"，界面也不再提供
  //   "移出"这个选项，能走到这里就是调用方写错了。静默替他选一个目标，会让
  //   "这条会话为什么在这个工作区里"变成一个查不清的问题。
  for (const bad of [null, '']) {
    const out = await call('PATCH', '/api/kernel/sessions/' + wsxLockedSession, {
      token: adminToken, json: { title: '受限区里的会话', workspaceId: bad },
    });
    assert.equal(out.status, 400, '空目标要 400，实际 ' + out.status + '：' + JSON.stringify(out.body));
    assert.match(out.body.error.message, /目标工作区/,
      '拒绝理由要说人话（"已没有移出到未分组这回事"）：' + JSON.stringify(out.body));
  }
  const afterBad = await call('GET', '/api/kernel/sessions/' + wsxLockedSession, { token: adminToken });
  assert.equal(afterBad.body.session.workspaceId, wsxOpenId, '被拒的移动不能把会话挪走');

  // 挪回受限区，好让下面那次删除有货可搬
  const back = await call('PATCH', '/api/kernel/sessions/' + wsxLockedSession, {
    token: adminToken, json: { title: '受限区里的会话', workspaceId: wsxLockedId },
  });
  assert.equal(back.body.session.workspaceId, wsxLockedId);

  // 删工作区：会话**原地保留**，只是改挂到默认工作区
  const del = await call('DELETE', '/api/workspaces/' + wsxLockedId, { token: adminToken });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.deleted, true);
  assert.equal(del.body.movedSessions, 2, '里面两个会话都被搬走（探针 B 那个 + 管理员那个）');
  assert.equal(del.body.toWorkspaceId, defId, '落点就是兜底工作区');
  assert.equal(del.body.toWorkspaceName, '默认工作区', '回执要带落点名字 —— 前端照它写确认语');
  assert.ok(/默认工作区/.test(String(del.body.note || '')), 'note 要说清会话去哪了：' + del.body.note);

  const still = await call('GET', '/api/kernel/sessions/' + wsxLockedSession, { token: adminToken });
  assert.equal(still.status, 200, '会话本身不因工作区被删而消失 —— 删的是组织容器，不是里面的人');
  assert.equal(still.body.session.workspaceId, defId, '会话改挂到默认工作区（不再是一条"无归属"的行）');

  const t2 = await call('GET', '/api/workspaces', { token: adminToken });
  assert.equal(t2.body.items.find((w) => w.id === defId).sessionCount, defBefore + 2,
    '默认工作区的会话数要跟着涨 2');
  assert.equal(t2.body.ungroupedCount, undefined, '树上没有"未分组"这个桶了');

  const delAgain = await call('DELETE', '/api/workspaces/' + wsxLockedId, { token: adminToken });
  assert.equal(delAgain.status, 404, '再删是 404');
});

await t('兜底工作区不能改名、不能删除 —— 它是"删工作区时会话落到哪"那个问题的答案', async () => {
  // 为什么要单独钉这两条：兜底工作区是本次"删掉未分组"换来的**唯一**落点保证。
  // 它能被改名或被删掉的话，"落点"就没有保证了 —— 删 A 时落进 B，紧接着把 B 删掉，
  // 里面的会话就没有去处。所以这两条不是"多余的防御"，是不变量的另一半。
  const tree = await call('GET', '/api/workspaces', { token: adminToken });
  const defId = tree.body.defaultWorkspaceId;
  const def = tree.body.items.find((w) => w.id === defId);
  assert.ok(def && def.isDefault, '树里要标出哪一条是兜底的');

  // 改名 → **403**（不是 404：这条工作区**存在**，只是这个动作不许做）
  const rename = await call('PATCH', '/api/workspaces/' + defId, {
    token: adminToken, json: { name: '想给它改个名' },
  });
  assert.equal(rename.status, 403, JSON.stringify(rename.body));
  assert.match(rename.body.error.message, /兜底工作区/,
    '要说明"为什么不行"，而不是干巴巴一句 forbidden：' + JSON.stringify(rename.body));

  // ★ 反向：把**原名原样**传回来不该被拒。前端有时会把原值一起 PATCH 回来，
  //   拦"没变的东西"只会让人以为接口坏了 —— 而那与"不能改名"是两件不同的事。
  const replay = await call('PATCH', '/api/workspaces/' + defId, {
    token: adminToken, json: { name: def.name },
  });
  assert.equal(replay.status, 200, '原名重放应当通过：' + JSON.stringify(replay.body));

  // 删除 → 403
  const del = await call('DELETE', '/api/workspaces/' + defId, { token: adminToken });
  assert.equal(del.status, 403, JSON.stringify(del.body));
  assert.match(del.body.error.message, /不能删除/, '理由要说清："把它删掉，那些会话就没有去处了"：'
    + JSON.stringify(del.body));

  // ★ 禁的是"改名"和"删除"两件事，不是"这一行只读" —— 说明字段照样能改。
  //   不钉这条的话，"整行锁死"的实现也会让上面两条全绿。
  const descOk = await call('PATCH', '/api/workspaces/' + defId, {
    token: adminToken, json: { description: '__probe_desc__' },
  });
  assert.equal(descOk.status, 200, '说明字段要能改：' + JSON.stringify(descOk.body));
  assert.equal(descOk.body.workspace.description, '__probe_desc__');

  // 收拾：把说明改回去（这条工作区属于别的用例的前提，别留下痕迹）
  const restore = await call('PATCH', '/api/workspaces/' + defId, {
    token: adminToken, json: { description: def.description || '' },
  });
  assert.equal(restore.status, 200, JSON.stringify(restore.body));

  // 兜底工作区还在（上面那次删除被拦住了，没真删掉）
  const after = await call('GET', '/api/workspaces', { token: adminToken });
  assert.equal(after.body.defaultWorkspaceId, defId, '兜底工作区一直都在');
  assert.equal(after.body.items.filter((w) => w.isDefault).length, 1, '仍然恰好一条兜底工作区');
});

await t('模式与推理等级：建会话时带上并落库；换模型时一并落；每次都回报**落库值**', async () => {
  const created = await call('POST', '/api/kernel/sessions', {
    token: adminToken,
    json: { title: '带模式与档位的会话', workspaceId: wsxOpenId, presetId: 'ptc', reasoningEffort: 'low' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.session.presetId, 'ptc', '模式要落库并回显（不是只透传给上游）');
  assert.equal(created.body.session.reasoningEffort, 'low');
  const sid = created.body.session.id;

  const got = await call('GET', '/api/kernel/sessions/' + sid, { token: adminToken });
  assert.equal(got.body.session.presetId, 'ptc');
  assert.equal(got.body.session.reasoningEffort, 'low');

  const listed = await call('GET', '/api/kernel/sessions?limit=200', { token: adminToken });
  const row = listed.body.items.find((s) => s.id === sid);
  assert.ok(row, '新会话要出现在列表里');
  assert.equal(row.workspaceId, wsxOpenId, '列表要回显工作区 —— 树按它分组');
  assert.equal(row.presetId, 'ptc', '列表也要回显模式 —— 头部要显示当前模式');
  assert.equal(row.reasoningEffort, 'low', '列表也要回显推理等级');

  // 0.21.0 前推理等级只透传不落库：重启后"这个会话用什么推理等级"就丢了。这条钉住"真的记下来了"。
  const m = await call('POST', '/api/kernel/sessions/' + sid + '/model', {
    token: adminToken, json: { provider: 'stub', model: 'stub-deterministic', reasoningEffort: 'max' },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.recorded.reasoningEffort, 'max', '选模型时要一并落库（录的是"平台要求上游用的"，不是观测值）');

  const got2 = await call('GET', '/api/kernel/sessions/' + sid, { token: adminToken });
  assert.equal(got2.body.session.reasoningEffort, 'max', '再看一次仍是落库值');
});

await t('工作区动作全部留审计（前缀 workspace. 可逐条对账，含建/改/删与落点）', async () => {
  const r = await call('GET', '/api/governance/audit?action=workspace.&limit=200', { token: adminToken });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const actions = new Set(r.body.items.map((x) => x.action));
  for (const a of ['workspace.create', 'workspace.update', 'workspace.delete']) {
    assert.ok(actions.has(a), '审计里少了 ' + a + '，实际有：' + [...actions].join(' / '));
  }
  // 删除那条有两个来源，必须分清：
  //   · **服务层**审计（action=workspace.delete，detail 带 movedSessions）——"发生了什么业务事实"；
  //   · **路由层**请求流水（action 也用 route.id，detail 是 method/path/status）——"谁调过这个接口"。
  // 两者同名是既有设计（middleware 用路由 id 当动作名）。所以这里按 detail 的形状找出服务层那条，
  // 而不是 `find(action==='workspace.delete')` —— 那会随机命中流水，断出一个与业务无关的结论。
  const del = r.body.items.find((x) => x.action === 'workspace.delete'
    && x.detail && x.detail.movedSessions !== undefined);
  assert.ok(del, '要有服务层那条删除审计（detail 带 movedSessions）');
  assert.equal(del.detail.movedSessions, 2, '删除那条要记下"搬走了几个会话"：' + JSON.stringify(del.detail));
  // ★ 落点也要记。审计要能回答"那些会话去哪了" —— 只记"搬走了 2 个"的话，
  //   事后对账仍然得把库翻一遍才知道落点（而那个工作区可能已经被改名/删除）。
  const auditTree = await call('GET', '/api/workspaces', { token: adminToken });
  assert.equal(del.detail.toWorkspaceId, auditTree.body.defaultWorkspaceId,
    '删除审计要记下落点工作区 id：' + JSON.stringify(del.detail));
  assert.equal(del.detail.name, '第二个工作区',
    '还要记下被删的那个工作区叫什么（那行已经没了，只有这条审计能对上）：' + JSON.stringify(del.detail));
});

await t('会话列表回显管理权（canManage）：与动作守卫同判据 —— 板上的"⋯"照它亮灯', async () => {
  // 为什么这条要在 HTTP 层钉：`canManage` 是"列表回显"与"动作守卫"必须同源的那个值。
  // 单测服务层只能证明它算得对，证明不了**路由把它发出去了**，而前端正是照它决定
  // 菜单里摆不摆改名/删除。两端之间断一条，用户看到的就是"按钮亮着、点了 403"。
  //
  // 0.21.6 起判据只剩"组织角色推导的档位 × 是不是我的会话"（工作区级授权已删），
  // 所以这里用**同一工作区里的两条会话**做正反对照：member 对自己的（write 够）vs
  // 对别人的（要 full），再加 admin 对别人的（full 够）—— 一条断言只测一边，
  // 在"一律要 full"的实现下照样绿。
  const g = await call('POST', '/api/workspaces', {
    token: adminToken, json: { name: '管理权探针区', cwd: '/tmp/sti-wsx-canmanage' },
  });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const wsId = g.body.workspace.id;

  // 管理员（full 档）建一条 —— 待会儿就是"别人的会话"
  const sAdmin = await call('POST', '/api/kernel/sessions', {
    token: adminToken, json: { title: '管理员的会话', workspaceId: wsId },
  });
  assert.equal(sAdmin.status, 201, JSON.stringify(sAdmin.body));
  const adminSid = sAdmin.body.session.id;

  // 探针 B（全局 member = write 档）在**同一个工作区**里建自己的
  const sMine = await call('POST', '/api/kernel/sessions', {
    token: wsxBToken, json: { title: '探针B自己的会话', workspaceId: wsId },
  });
  assert.equal(sMine.status, 201, JSON.stringify(sMine.body));
  const bSid = sMine.body.session.id;

  /**
   * 以某个 token 的视角读一条会话的管理权回显。
   * ⚠️ 必须用**被观测者自己**的 token 去读 —— 拿管理员的 token 去读只会永远看到
   *    canManage:true，那就什么都没钉住。
   */
  const rightOf = async (sid, token) => {
    const r = await call('GET', '/api/kernel/sessions?limit=200', { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.items.find((x) => x.id === sid);
  };

  // ① member 看**自己的**会话：write 档就够
  const b1 = await rightOf(bSid, wsxBToken);
  assert.ok(b1, '探针 B 要看得见自己的会话');
  assert.equal(b1.isMine, true, 'isMine 要如实说是谁的会话');
  assert.equal(b1.manageNeed, 'write', '自己的会话 write 档就够');
  assert.equal(b1.canManage, true, '自己的会话在 write 档下必须能管');

  // ② member 看**别人的**会话：**仍然**管不了 —— 这是最容易写错的那一档
  const b2 = await rightOf(adminSid, wsxBToken);
  assert.ok(b2, '工作区现在全组织可见，别人的会话也看得见');
  assert.equal(b2.isMine, false);
  assert.equal(b2.manageNeed, 'full', '不是自己的会话，要完全权限');
  assert.equal(b2.canManage, false,
    'write 档只能管**自己的**会话；别人的会话要点到 full —— 这里若是 true，菜单里就会多出点了必然 403 的按钮');

  // ③ admin（full 档）看**别人的**会话：管得了 —— ② 的反证
  const a1 = await rightOf(bSid, adminToken);
  assert.equal(a1.isMine, false, '这条是探针 B 建的');
  assert.equal(a1.manageNeed, 'full');
  assert.equal(a1.canManage, true, 'full 档能管别人的会话（与守卫 guardWsOwnership 同一判据）');
  assert.notEqual(b2.canManage, a1.canManage,
    '同一档需求、两个组织角色、两个结论 —— 不这样对照，"一律 canManage:false"也能全绿');

  // ④ 0.21.9：「未分组」整个删了 —— 不给 workspaceId 建的会话**落进兜底工作区**，
  //    于是它的档位与"在工作区里的会话"逐字同判（自己的 write、别人的 full），
  //    不再有"没有档位"那一档。
  //    ⚠️ 那一档是一处**暗门**，不是一条兼容：判据是 `need: null` + `can: true`，
  //       而 `assertSessionAccess` 见到空归属就直接放行 —— **没有档位 = 没有门**。
  //       下面那条 viewer 的断言正是它的露馅处。
  const treeM = await call('GET', '/api/workspaces', { token: adminToken });
  const defIdM = treeM.body.defaultWorkspaceId;
  const sFree = await call('POST', '/api/kernel/sessions', {
    token: adminToken, json: { title: '不给工作区的会话' },
  });
  assert.equal(sFree.status, 201, JSON.stringify(sFree.body));
  assert.equal(sFree.body.session.workspaceId, defIdM,
    '不给 workspaceId 就落进兜底工作区（不再写出一条"无归属"的行）');

  const free = await rightOf(sFree.body.session.id, adminToken);
  assert.equal(free.isMine, true);
  assert.equal(free.manageNeed, 'write', '自己的会话 write 档就够 —— 与工作区里的会话同一个判据');
  assert.equal(free.canManage, true);

  // 只读账号（探针 A 全局 viewer）看同一条会话：能看见，但管不了。
  // ⚠️ 从前这里断言的是 `manageNeed: null` + `canManage: true`（"未分组会话跟着全局
  //    session:write 走，人人可管"）—— 同一条会话换 viewer 来看，判据不变，仍然是 can:true。
  //    这就是"删掉未分组"要修的东西：**没有档位的那一档等于没有门**。
  const freeV = await rightOf(sFree.body.session.id, wsxAToken);
  assert.ok(freeV, '会话对任何有 session:read 的人可见');
  assert.equal(freeV.manageNeed, 'full', '不是自己的会话就要完全权限（与 ② / ③ 同一判据）');
  assert.equal(freeV.canManage, false, 'viewer 管不了（rw 与档位两半都要过）');

  // 收拾场地：这个探针工作区只为本用例存在，删掉它免得影响后面的树计数断言。
  // ⚠️ 0.21.9 起，删工作区会把里面的会话搬到**默认工作区** —— 所以下面那些
  //    "默认工作区里有几条会话"的断言不能再写成恰好 1（那是"会话落回未分组"时代的写法）。
  const clean = await call('DELETE', '/api/workspaces/' + wsId, { token: adminToken });
  assert.equal(clean.status, 200, JSON.stringify(clean.body));
  assert.equal(clean.body.movedSessions, 2, '里面两个会话都落进默认工作区');
  assert.equal(clean.body.toWorkspaceId, defIdM, '落点就是兜底工作区');
});

await t('默认工作区播种：只在"一个工作区都没有"时补一个，且幂等、记建档人、留审计', async () => {
  // 为什么不通过 HTTP 测初始化向导那条路：本套回归的库已经初始化过了（setup 只跑一次），
  // 向导里那一句 `ensureDefaultWorkspace` 在这条时间线上不可能再被执行到。
  // 直接测服务层同一个函数，才是真正在钉"补默认工作区"这条逻辑本身。
  //
  // ⚠️ 用一个**独立租户 id**（不对应任何 org 行）：这样就有一个"干净的、一个工作区都没有的"
  //    场地，而不是把当前组织的工作区删光 —— 那会连带毁掉上面所有用例的前提。
  const probeTenant = 'tenant-default-wsx-' + wsxStamp;

  const first = workspace.ensureDefaultWorkspace({
    tenantId: probeTenant, ownerUserId: 'u-owner-probe', cwd: '/tmp/sti-default-ws',
  });
  assert.ok(first, '空租户要补出一个默认工作区');
  assert.equal(first.name, '默认工作区',
    '默认名字由服务层给（"补不补"只看有没有，不看叫什么；这个名字本身现在不能改，见下一条用例）');
  assert.equal(first.cwd, '/tmp/sti-default-ws', 'cwd 要落的是传进来的那个目录（生产里由 paths.mjs 推导）');
  assert.equal(first.owner_user_id, 'u-owner-probe', '建档人记下来 —— 会话的 owner 与审计都取自它');
  // 反向断言：工作区没有 `visibility` 了（迁移 0023 已删列）
  assert.equal(first.visibility, undefined, '工作区不该再有 visibility 字段（迁移 0023 已删）');
  // ★ 播种出来的必须是**兜底工作区**（`is_default = 1`）—— 这个标记是本次"删掉未分组"
  //   换来的落点保证：删任何一个工作区，里面的会话都搬到它这里；也正因为它，它自己
  //   不能被改名 / 删除。没标上就等于"删工作区时会话没有去处"。
  const seededTree = workspace.listTree(probeTenant);
  assert.equal(seededTree.items[0].isDefault, true, '播种出来的就是兜底工作区（is_default = 1）');
  assert.equal(seededTree.defaultWorkspaceId, first.id, 'defaultWorkspaceId 要指到它');

  // ⚠️ 0.21.9：落脚会话（以及配套的 `session.default.seed` 审计）**整块删除**（用户裁定）——
  //    新装平台初始化后**只有默认工作区**，树里没有预先躺着的会话。
  //    这里因此改成**反向断言**：播种**不许**再顺手造任何会话。
  //    改断言而不是改代码：消失的是一条被明确裁掉的行为，不是漏接线。
  const seeded = seededTree.items;
  assert.equal(seeded.length, 1, '补过之后只有一个工作区');
  assert.equal(seeded[0].sessionCount, 0, '0.21.9 起播种不再造落脚会话 —— 默认工作区应当是空的');
  {
    // 直查库：这个探针租户里**一行会话都不该有**。用表名硬编码而不是仓储，
    // 是因为这条断言要的是"物理上有没有行"，不是"仓储怎么理解它"。
    const n = db.get('SELECT COUNT(*) AS c FROM agent_sessions WHERE tenant_id = ?', [probeTenant]).c;
    assert.equal(n, 0, '播种不该在这个租户里留下任何会话（含非默认工作区的）');
  }

  const again = workspace.ensureDefaultWorkspace({ tenantId: probeTenant, cwd: '/tmp/别的目录' });
  assert.equal(again, null, '已经有工作区就一步不动（幂等）—— 否则每启动一次就多一个');
  const rows = workspace.listTree(probeTenant).items;
  assert.equal(rows.length, 1, '补过之后只有那一个（再调不会新增）');
  assert.equal(rows[0].cwd, '/tmp/sti-default-ws', 'cwd 不会被第二次调用改掉');
  assert.equal(rows[0].sessionCount, 0, '第二次调用同样不该冒出会话');

  // 已有的组织（本套回归所在的那个）不该被动过：它有工作区，所以返回 null
  const orgList = await call('GET', '/api/workspaces', { token: adminToken });
  const before = orgList.body.items.length;
  const noop = workspace.ensureDefaultWorkspace({ tenantId: orgId, cwd: '/tmp/不应该生效' });
  assert.equal(noop, null, '当前组织已经有工作区 —— 播种必须一步不动');
  const after = await call('GET', '/api/workspaces', { token: adminToken });
  assert.equal(after.body.items.length, before, '树里的工作区数不能因播种而变');

  // 留痕：补默认工作区是一件"平台替谁做了什么"的事，必须能在审计里逐条对账。
  // ⚠️ 这里走**服务层**而不是 HTTP 审计接口：那条接口按 `ctx.tenantId` 过滤，
  //    而探针工作区挂在探针租户下 —— 拿管理员的 token 去查本来就该查不到
  //    （看不见别的租户的审计是对的）。用租户 id 直查才是这条断言的正确落点。
  const seededAudit = audit.query(probeTenant, { action: 'workspace.default.seed', limit: 50 });
  assert.equal(seededAudit.items.length, 1, '要留下恰好一条 workspace.default.seed 审计（幂等也就意味着只留一次）');
  assert.equal(seededAudit.items[0].resource_id, first.id);
  assert.equal(seededAudit.items[0].user_id, 'u-owner-probe', '审计要记下"替谁建的"');

  // 反向断言：`session.default.seed` 这条审计动作**不许再出现** ——
  // 它只服务于被删掉的落脚会话。谁把播种会话加回来，这条会立刻红。
  const seedSessAudit = audit.query(probeTenant, { action: 'session.default.seed', limit: 50 });
  assert.equal(seedSessAudit.items.length, 0, 'session.default.seed 随落脚会话一并删除（0.21.9），不许再产生');
});

await t('初始化向导：走完就有一个能立刻用的默认工作区（新装的平台不该看到空树）', async () => {
  // 这条能测到，正是因为**本套回归的库也走了一遍真实初始化向导**（见文件前半段的
  // POST /api/identity/setup）—— 所以"向导里那句 ensureDefaultWorkspace 到底跑没跑"
  // 是这条时间线上真发生过的事实，不是模拟出来的。
  const org = await call('GET', '/api/identity/setup');
  assert.equal(org.status, 200, JSON.stringify(org.body));

  const tree = await call('GET', '/api/workspaces', { token: adminToken });
  assert.equal(tree.status, 200, JSON.stringify(tree.body));
  const seeded = tree.body.items.filter((w) => w.name === '默认工作区');
  assert.equal(seeded.length, 1, '组织里应当正好有一个"默认工作区"（向导建的）：'
    + JSON.stringify(tree.body.items.map((w) => w.name)));

  // cwd 必须是**运行时推导**出来的那个目录（测试里数据目录是临时目录，所以这里只能验形态：
  // 绝对路径 + 以 workspace 结尾）。钉的是"不是空的、不是 process.cwd() 那种随命令走的相对值"。
  const cwd = seeded[0].cwd;
  assert.ok(cwd && /(^|[\\/])workspace$/.test(cwd),
    '默认工作区的 cwd 要指向 .../workspace（由 paths.mjs 推导），实际：' + cwd);
  // 反向断言：工作区不再有档位 / 可见性这两样"平台自己的权限说法"
  assert.equal(seeded[0].visibility, undefined, '工作区不该再有 visibility（迁移 0023 已删）');
  assert.equal(seeded[0].myLevel, undefined, '树不该再下发 myLevel（档位界面已删）');
  // ★ 0.21.9：向导建出来的默认工作区**不带落脚会话**（用户裁定：初始化后只有默认工作区，
  //    树里没有预先躺着的会话）。这里改成**反向断言**——"新会话"那条不许存在。
  //    改断言而不是改代码：消失的是一条被明确裁掉的行为，不是漏接线。
  const sessList = await call('GET', '/api/kernel/sessions?limit=200', { token: adminToken });
  assert.equal(sessList.status, 200, JSON.stringify(sessList.body));
  const inDefault = sessList.body.items.filter((s) => s.workspaceId === seeded[0].id);
  assert.ok(!inDefault.some((s) => s.title === '新会话'),
    '0.21.9 起向导不再播落脚会话 —— 默认工作区里不该有标题「新会话」的那条。里面实际有：'
    + JSON.stringify(inDefault.map((s) => s.title)));
  // 建档人必须是**初始化时的那个管理员**（不是空着的"无主工作区"）：
  // 会话的 owner、审计的 user_id 都取自它，空掉就等于平台建的东西没有主。
  const me = await call('GET', '/api/identity/me', { token: adminToken });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(seeded[0].ownerUserId, me.body.user.id,
    'owner 要记成初始化时创建的管理员账号，实际：' + seeded[0].ownerUserId);

  // 审计同样要留痕（这次用 HTTP 接口查 —— 它属于**当前**租户，看得见）
  const auditList = await call('GET', '/api/governance/audit?action=workspace.default.seed&limit=50', { token: adminToken });
  assert.equal(auditList.status, 200, JSON.stringify(auditList.body));
  assert.ok(auditList.body.items.some((x) => x.resource_id === seeded[0].id),
    '向导补的默认工作区要留审计：' + JSON.stringify(auditList.body.items.slice(0, 3)));
});


/* ── 13. 内核热切换（0.21.3 / 0.21.4）────────────────────────────────
 *
 * 这一组钉的是本版本推翻的那句产品承诺：内核连接**保存即生效**，不再需要重启。
 * 之所以值得单独一组，是因为"热切换"最容易做成两种假货：
 *   ① **只改了个字段**，运行中的门面没换 —— 探测显示已切、实际还在用旧的；
 *   ② **界面说成功、其实没换** —— 从前那条"会降级所以这次先不切"的保护判断就是这种：
 *      它留着上一次的内核继续跑，用户以为按新地址生效了。
 * 两条各有一个钉子，并且都必须**观测到门面本身变了**（读 `kernel.dshStatus` / `kernel.ready`），
 * 不能只看响应体：响应体可能只是把请求里的配置回显了一遍。
 *
 * ⚠️ 0.21.5 起，"保存一个连不上的地址"**走不到 HTTP 保存口**了（保存前必须先检测通过），
 * 所以 ② 那个钉子改成直接驱动装配层（见下面第二条）—— 它要钉的东西本来就在那一层。
 *
 * 本组每个用例结尾都调 `restoreStubKernel()` —— 后面还有用例要用内核。
 */

await t('★ 内核热切换：保存可达地址 → 当场生效（无需重启），status 同步自洽', async () => {
  const up = await liveKernelStub();
  try {
    const r = await call('POST', '/api/system/kernel/config', {
      token: adminToken,
      json: { origin: 'http://127.0.0.1:' + up.port },
    });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.body.saved, true);

    // ① 不再要求重启
    assert.equal(r.body.restartRequired, false, '不该再要求重启：' + String(r.body.restartNote));
    // ② 运行中的门面**真的**换了（只看响应体不够 —— 那可能只是回显了配置）
    assert.ok(kernel.dshStatus && String(kernel.dshStatus.origin).includes(':' + up.port),
      '门面应当场指向新地址，实际：' + String(kernel.dshStatus && kernel.dshStatus.origin));
    assert.equal(kernel.ready, true, '这个桩按真实内核的特征应答，应报"已接入"');
    assert.equal(r.body.switched.ready, true);
    assert.equal(r.body.effective.ready, true);

    // ③ 状态接口自洽：配置与运行值一致 → 那句"需要重启"的诊断必须**自己消失**。
    //    这是旧行为的反向钉子：以前它永远为真，现在它得有能力变假。
    const st = await call('GET', '/api/kernel/status', { token: adminToken });
    assert.equal(st.body.ready, true);
    assert.equal(st.body.restart.pending, false, '已当场切换，不该再说配置与运行值不一致');
  } finally {
    await up.close();
    restoreStubKernel();
  }
});

await t('★ 内核热切换：目标连不上时**照切**，不许偷偷留着旧内核装作没事', async () => {
  // 这条从前是走 HTTP 保存口的（`force: true` + 一个死地址）。0.21.5 删掉那条旁路后
  // 它走不到了 —— 但**要钉的东西没消失**，只是上移了一层：现在还能造出"目标不可用却仍要切"
  // 的真实情形只有一种，运维直接手改 config.json 之后再触发重新装配。
  // 于是这里直接驱动装配层：那条保护性判断本来就在 compose/kernel.mjs 里。
  //
  // 钉住的历史缺陷形态很具体：那段判断"新配置会降级、而当前内核可用 → 就不切"，
  // 保住的是"不把正在用的内核踢下去"，代价是**用户以为按新地址生效了、其实没换**。
  // 0.21.4 删掉 mock 降级后那段判断也删了：现在保存什么就是什么，连不上就如实变成不可用，
  // 由前端整页拦住并要求重新接入（见 public/app/60-platform.js 的 pageKernelGate）。
  const dead = await deadPort();
  const cfgFile = path.join(DATA_DIR, 'config.json');
  const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cur.dshOrigin = 'http://127.0.0.1:' + dead;
  const { writeConfigFile } = await import('../app/config.mjs');
  writeConfigFile(cur);

  try {
    const sw = await reloadKernel({ config, keyring: MASTER, kernel });
    assert.equal(sw.applied, true, '照切：不该因为"目标不可用"就不切');
    assert.equal(sw.ready, false, '连不上的地址就是不可用');
    assert.equal(kernel.ready, false, '门面本身也要变成不可用，不能偷偷留着旧内核装作没事');
    assert.ok(!kernel.dshStatus || String(kernel.dshStatus.origin).includes(':' + dead),
      '门面必须指向新地址（不是留在旧的那个上），实际：'
      + String(kernel.dshStatus && kernel.dshStatus.origin));
  } finally {
    restoreStubKernel();
  }
});

/* ── 收尾 ────────────────────────────────────────────────────────── */

await new Promise((r) => server.close(r));
// 先停 worker 池再关库：worker 线程默认让进程保持存活，不倒这一步脚本会挂住不退出
try { await knowledge.close(); } catch { /* ignore */ }
try { db.closeDb(); } catch { /* ignore */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('');
console.log('='.repeat(64));
if (fails) {
  console.log('失败明细：');
  for (const f of failures) {
    console.log('  · ' + f.name);
    console.log('    ' + String((f.error && f.error.message) || f.error).split('\n')[0]);
  }
  console.log('');
}
if (skipped.length) {
  console.log('跳过的用例（**不计入通过**，请自行判断是否可接受）：');
  for (const s of skipped) {
    console.log('  ~ ' + s.name);
    console.log('      ' + s.reason);
  }
  console.log('');
}
console.log('用例 ' + total + ' 个｜失败 ' + fails + ' 个' + (skips ? '｜跳过 ' + skips + ' 个' : ''));
console.log('DONE fails=' + fails);
process.exitCode = fails ? 1 : 0;
