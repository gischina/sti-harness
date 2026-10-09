/**
 * 治理与审计端到端回归（M3 验收的核心手段）。
 *
 * 覆盖四条验收标准：
 *   1. 人为删改任一审计行后，校验接口**准确定位断裂点**；
 *   2. 审计覆盖度：清单里每个动作类型都有对应用例产出审计记录；
 *   3. 配额拦截与权限拒绝**同样留痕**（result = denied）；
 *   4. 用量数字来自真实事件 —— 与 usage 事件**逐字段**可比对；
 *
 * 自包含：临时数据目录 + 随机端口 + 测试替身，不依赖本机服务、不碰真实 data/。
 * 用法：node tools/test-governance.mjs   末行输出 `DONE fails=0`。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';

// ⚠️ 必须在任何 app 模块之前设好（paths.mjs 在模块求值时读 DATA_DIR）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-gov-'));
process.env.STI_DATA_DIR = tmp;
process.env.STI_LOG_LEVEL = 'error';
// 内核改由下面**显式注入测试替身**（0.21.4 起没有"内核模式"这个开关了）。
process.env.STI_RATE_LIMIT = '100000';
process.env.STI_RATE_LIMIT_LOGIN = '100000';   // 登录路由有独立阈值，回归不测它就别被它挡

// 固定的备份密钥（2026-10 安全评审 P1-7）：本套件所有备份走同一把密钥，
// verify/restore 都显式传它；加密专项用例另行验证"无 key/错 key/签名篡改"。
const BACKUP_KEY = crypto.randomBytes(32).toString('hex');

await import('../app/util/quiet-warnings.mjs');
const { ensureRuntimeDirs, DB_FILE } = await import('../app/paths.mjs');
const db = await import('../app/data/db.mjs');
const migrate = await import('../app/data/migrate.mjs');
const { loadConfig } = await import('../app/config.mjs');
const { createIdentityService } = await import('../app/platform/identity/service.mjs');
const { createKnowledgeService } = await import('../app/platform/knowledge/service.mjs');
// 0.21.0 起还必须给出工作区服务：工作区路由在**装配期**就要 deps.workspace，
// 少了它这套回归会一行断言都没跑就抛错退出（末行缺失 → 门禁判"没跑到末尾"）。
// 这是"脚手架必须与 app/main.mjs 同构装配"那条纪律的又一次落地。
const { createWorkspaceService } = await import('../app/platform/workspace/service.mjs');
const { createGovernanceService } = await import('../app/platform/governance/service.mjs');
const { createOperationService } = await import('../app/platform/operation/service.mjs');
const { createModelService } = await import('../app/platform/model/service.mjs');
const { createScheduleService } = await import('../app/platform/schedule/service.mjs');
const { createNotifyService } = await import('../app/platform/notify/service.mjs');
const { createKernel } = await import('../app/kernel/index.mjs');
const { createKernelStub } = await import('./kernel-stub.mjs');
// 0.21.3：能力闸的**组合方式**只有 compose 层一处定义（`gated`），这里直接复用 ——
// 在测试里抄一遍的后果是"测试验的是抄的那份"，两者悄悄漂开时谁也发现不了。
const { gated } = await import('../app/compose/kernel.mjs');
const { createServer } = await import('../app/http/server.mjs');
const audit = await import('../app/platform/governance/audit.mjs');
const { readZipEntries, zipSync } = await import('../app/util/zip.mjs');
const caps = await import('../app/platform/capability/service.mjs');
// 能力闸不再在这里直接 import：它的组合方式收口到 compose 层的 `gated`（见上）
const { decryptSecret, encryptSecret, createSecretKeyring, cipherKid } = await import('../app/platform/identity/credentials.mjs');
const { reencryptSecrets } = await import('../app/platform/operation/keyrotate.mjs');

let total = 0;
let fails = 0;
let skips = 0;
const failures = [];
const skipped = [];

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
console.log('STI HARNESS 治理与审计端到端回归（M3）');
console.log('='.repeat(64));

/* ── 装配 ────────────────────────────────────────────────────────── */

ensureRuntimeDirs();
db.openDb(DB_FILE);
migrate.migrate();

const masterSecret = crypto.randomBytes(32);
const identity = createIdentityService({ masterSecret });
const config = loadConfig();
// 显式注入测试替身：产品路径上没有"没配地址也能用"的内核（那层降级已删）。
//
// ⚠️ MCP 清单**必须**接上平台登记表读取器（0.21.10 修）。替身早先硬编码返回
//    `servers: []`，于是能力闸拿到的候选恒为空 —— "deny 一个 MCP 服务后
//    契约层立即看不见"这条验收标准**永远绿**，而它其实一行也没测到。
//    这与产品侧 `compose/kernel.mjs` 注入的是同一个函数，口径一致。
const kernel = createKernel({
  provider: createKernelStub({ listMcpServers: () => caps.listMcpServersAcrossTenants() }),
  reason: '回归用测试替身（不依赖真实内核）',
});
// 与 main.mjs 相同的装配：契约层 gate 必须在测试里复现，验收标准 1 的断言才有意义。
// ⚠️ 用 `swap()` 而不是 `kernel.provider = …`（0.21.3）：门面对外全是 getter，
// 直接赋值会当场抛 TypeError —— 这个形状本身也是在提醒"装配要整体换，别单点改"。
kernel.swap({ provider: gated(kernel.provider) });
const knowledge = createKnowledgeService({ config, audit, resolveCredential: () => null });
// 与 main.mjs 同构装配。本套回归不测工作区，但它必须在场（见上面的 import 注释）。
const workspace = createWorkspaceService({ identity, audit });
const governance = createGovernanceService();
const { server } = createServer({
  config, kernel, identity, knowledge, workspace, governance,
  operation: createOperationService({ dataDir: tmp, backupKey: BACKUP_KEY }),
  model: createModelService({}),
  // P1-2：只为满足路由装配
  notify: createNotifyService({}),
  schedule: createScheduleService({}),
  paths: { DATA_DIR: tmp }, startedAt: Date.now(),
  masterSecret,
  decryptMcpConfig: (cipher) => { try { return decryptSecret(cipher, masterSecret); } catch { return null; } },
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const BASE = 'http://127.0.0.1:' + server.address().port;

const ADMIN = { username: 'admin', password: 'Adm1n-Pass!23' };
const VIEWER = { username: 'viewer1', password: 'V1ewer-Pass!23' };

async function call(method, p, { token, json, headers = {} } = {}) {
  const h = { ...headers };
  if (json !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, {
    method, headers: h, body: json === undefined ? undefined : JSON.stringify(json), redirect: 'manual',
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON 留 null */ }
  return { status: res.status, headers: res.headers, body, text };
}

let adminToken = null;
let viewerToken = null;
let orgId = null;
let sessionId = null;

/* ── 1. 装配与身份 ───────────────────────────────────────────────── */

section('装配与身份');

await t('初始化 → 管理员登录', async () => {
  const r = await call('POST', '/api/identity/setup', {
    json: { orgName: '治理测试组织', adminUsername: ADMIN.username, adminPassword: ADMIN.password, adminDisplayName: '管理员' },
  });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  orgId = r.body.org.id;
  const login = await call('POST', '/api/identity/login', { json: { username: ADMIN.username, password: ADMIN.password } });
  assert.equal(login.status, 200);
  adminToken = login.body.token;
  assert.ok(adminToken);
});

await t('建 viewer 账号并登录（用于越权用例）', async () => {
  const c = await call('POST', '/api/identity/users', {
    token: adminToken,
    json: { username: VIEWER.username, password: VIEWER.password, displayName: '只读访客', roles: ['viewer'] },
  });
  assert.equal(c.status, 201, c.text.slice(0, 200));
  const login = await call('POST', '/api/identity/login', { json: { username: VIEWER.username, password: VIEWER.password } });
  assert.equal(login.status, 200);
  viewerToken = login.body.token;
  assert.ok(viewerToken);
});

await t('治理接口未登录 → 401；viewer → 403（rbac 按 audit:read 判定）', async () => {
  const anon = await call('GET', '/api/governance/audit');
  assert.equal(anon.status, 401);
  const v = await call('GET', '/api/governance/audit', { token: viewerToken });
  assert.equal(v.status, 403, 'viewer 没有 audit:read，应 403');
  assert.equal(v.body.error.code, 'forbidden', '对外统一 403 文案（不泄漏判定细节）');
  assert.deepEqual(v.body.error.detail.needs, ['audit:read'], '但 needs 要告诉调用方缺什么');
  // viewer 对 quota 同样 403
  assert.equal((await call('GET', '/api/governance/quotas', { token: viewerToken })).status, 403);
});

/* ── 2. 用量采集（验收标准 4）────────────────────────────────────── */

section('用量采集：数字必须与 usage 事件逐字段一致');

await t('建会话并提交两轮对话', async () => {
  const s = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '用量回归' } });
  assert.equal(s.status, 201, s.text.slice(0, 200));
  sessionId = s.body.session.id;
  for (let i = 1; i <= 2; i++) {
    const turn = await call('POST', '/api/kernel/sessions/' + sessionId + '/turns',
      { token: adminToken, json: { content: '第 ' + i + ' 轮' } });
    assert.equal(turn.status, 200, turn.text.slice(0, 200));
    // 测试替身 脚本每轮固定吐一条 usage：input 128 / output 64 / reasoning 16
    const uc = turn.body.usageCollected;
    assert.equal(uc.written, 1, '每轮应采集到 1 条 usage 记录');
    assert.equal(uc.error, null);
    // ★ 逐字段可比对（验收标准 4 的核心断言）
    assert.deepEqual(uc.totals, { input: 128, cacheRead: 0, cacheWrite: 0, output: 64, reasoning: 16 },
      '采集值必须与事件里的 usage 逐字段一致（照抄，不是估算）');
  }
});

await t('汇总接口的数字与事件一致（计费输入 = input + cacheRead + cacheWrite）', async () => {
  const u = await call('GET', '/api/governance/usage', { token: adminToken });
  assert.equal(u.status, 200);
  const t2 = u.body.totals;
  assert.equal(t2.input, 256);
  assert.equal(t2.output, 128);
  assert.equal(t2.reasoning, 32);
  assert.equal(t2.billableInput, 256, '两轮 128，缓存为 0');
  assert.equal(u.body.byUser.length, 1);
  assert.equal(u.body.byUser[0].turns, 2, 'turns 汇总来自 usage 行数');
  assert.equal(u.body.byUser[0].username, 'admin',
    '按用户必须带出用户名（LEFT JOIN users）—— 一列裸 ID 逼管理员去账号页逐个对号');
  assert.ok(u.body.semantics && /计费输入/.test(u.body.semantics.billableInput), '语义说明要带上');
});

await t('turns 配额的已用量口径 = turn-start 事件数（不是 usage 行数）', async () => {
  // 直接看配额清单里的 used：哪怕某轮没有 usage 事件，turns 也必须数得到 —— 宁可查询贵也不漏计
  const r = governance.usage.consumed(orgId, { metric: 'turns', period: 'day' });
  assert.equal(r.used, 2, '两轮对话 → turns 已用量 2');
});

/* ── 3. 配额（验收标准 3）────────────────────────────────────────── */

section('配额：先检后放行，拦截与提醒都留痕');

await t('创建 turns/day 上限=1 的配额（此前已用 2 → 立即超限）', async () => {
  const r = await call('POST', '/api/governance/quotas', {
    token: adminToken,
    json: { subjectType: 'tenant', metric: 'turns', period: 'day', limitValue: 1, mode: 'block' },
  });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  const list = await call('GET', '/api/governance/quotas', { token: adminToken });
  const q = list.body.items.find((x) => x.metric === 'turns');
  assert.equal(q.used, 2, '配额清单要显示真实已用量');
  assert.equal(q.evaluated, true);
});

await t('超限后提交回合 → 403 quota_blocked + 审计 denied（验收标准 3）', async () => {
  const turn = await call('POST', '/api/kernel/sessions/' + sessionId + '/turns',
    { token: adminToken, json: { content: '应该被拦' } });
  assert.equal(turn.status, 403);
  assert.equal(turn.body.error.code, 'quota_blocked');
  assert.match(turn.body.error.message, /配额已达标/);

  // 权限拒绝与配额拦截**同样留痕**
  const org = audit.list(orgId, { limit: 100 });
  const blocked = org.filter((a) => a.action === 'governance.quota.block' && a.result === 'denied');
  assert.ok(blocked.length >= 1, '配额拦截必须写审计 denied');
  const d = JSON.parse(blocked[blocked.length - 1].detail_json);
  assert.equal(d.metric, 'turns');
  assert.ok(d.reason && /配额已达标/.test(d.reason), '审计要记下拦截原因');
  assert.equal(d.routeId, 'kernel.sessions.turns');
});

await t('warn 模式：超限但放行 + x-sti-quota-warning 头 + 审计 warn 记录', async () => {
  // 先删掉上一条 block 配额 —— 否则它仍会拦（worst-of 语义：任一 block 即 block）
  const list0 = await call('GET', '/api/governance/quotas', { token: adminToken });
  for (const q of list0.body.items.filter((x) => x.metric === 'turns' && x.mode === 'block')) {
    const del = await call('DELETE', '/api/governance/quotas/' + q.id, { token: adminToken });
    assert.equal(del.status, 200);
  }
  const up = await call('POST', '/api/governance/quotas', {
    token: adminToken,
    json: { subjectType: 'tenant', metric: 'turns', period: 'total', limitValue: 1, mode: 'warn' },
  });
  assert.equal(up.status, 201);
  const turn = await call('POST', '/api/kernel/sessions/' + sessionId + '/turns',
    { token: adminToken, json: { content: 'warn 下应放行' } });
  assert.equal(turn.status, 200, 'warn 不拦截');
  assert.equal(turn.headers.get('x-sti-quota-warning'), '1', 'warn 要有响应头提醒');

  const org = audit.list(orgId, { limit: 100 });
  const warned = org.filter((a) => a.action === 'governance.quota.warn');
  assert.ok(warned.length >= 1, 'warn 也要留痕（result=ok，治理动作可回溯）');
});

await t('配额 CRUD 的坏输入被拒绝（400 而非 500）', async () => {
  const bad = await call('POST', '/api/governance/quotas', {
    token: adminToken, json: { subjectType: 'tenant', metric: 'nope', period: 'day', limitValue: 1 },
  });
  assert.equal(bad.status, 400);
  const neg = await call('POST', '/api/governance/quotas', {
    token: adminToken, json: { subjectType: 'tenant', metric: 'turns', period: 'day', limitValue: -5 },
  });
  assert.equal(neg.status, 400);
  // P1-2 起并发闸**真的实装了**（内存计数，见 platform/governance/concurrency.mjs），
  // 因此清单里它必须是"已计量"（evaluated=true），并且 note 要说清
  // "瞬时量、无周期语义"——否则"已用 0/5"会被读成"今天一个人都没跑"。
  const cc = await call('POST', '/api/governance/quotas', {
    token: adminToken, json: { subjectType: 'tenant', metric: 'concurrent', period: 'total', limitValue: 5 },
  });
  assert.equal(cc.status, 201);
  const list = await call('GET', '/api/governance/quotas', { token: adminToken });
  const cq = list.body.items.find((x) => x.metric === 'concurrent');
  assert.equal(cq.evaluated, true, '并发闸已实装 → evaluated=true（不再标未实装）');
  assert.ok(/瞬时/.test(cq.note || ''), '要如实标注并发是瞬时量、无周期累计语义');
});

/* ── 4.5 产物留存（M4-0，M3 顺延项）────────────────────────────────── */

section('产物留存：服务层落库 + 会话日志 ZIP 导出');

// 这个样本文件在后面的「用系统默认程序打开」用例里还要用（那里要传一个**真实存在**的
// 路径去撞权限闸），所以提到区块作用域外 —— 否则 403 那条拿不到它，
// 只能自己再造一份，"两个测试各造一份样本"迟早会漂。
let outPath = null;

await t('产物记录由服务层落库（recordFromToolCall：路径提取 input/output 两方向）', async () => {
  // 平台侧工具执行已移除；产物清单的数据源是**回合事件流里的工具调用投影**
  // （kernel.mjs 对 ev.tool 的 recordFromToolCall）。这里直接在服务层造数，
  // 钉住"路径提取 + 落库 + 查询"这条留存链路本身。
  const marker = '/data/claims/' + Date.now() + '-授权书.pdf';
  const w1 = governance.artifacts.recordFromToolCall({
    tenantId: orgId, sessionId, turnId: null, toolName: 'stub.echo',
    args: { text: '来源材料：' + marker }, result: null,
  });
  outPath = path.join(tmp, 'm4-artifact-回执-样本.txt');
  fs.writeFileSync(outPath, '产物留存的端到端样本', 'utf8');
  const w2 = governance.artifacts.recordFromToolCall({
    tenantId: orgId, sessionId, turnId: null, toolName: 'stub.echo',
    args: null, result: { path: outPath },
  });
  assert.ok(w1.written >= 1 && w2.written >= 1, 'input/output 两方向都应落库');
});

await t('查询接口按会话列出（input + output 都在）', async () => {
  const list = await call('GET', '/api/governance/artifacts?sessionId=' + sessionId, { token: adminToken });
  assert.equal(list.status, 200);
  assert.ok(list.body.total >= 2, 'input + output 都应在列，实际 total=' + list.body.total);
  const paths = list.body.items.map((x) => x.path);
  assert.ok(paths.some((p) => p.includes('m4-artifact-回执-')), 'output 产物路径在列');
  assert.ok(paths.some((p) => p.includes('授权书')), 'args 里的路径在列');
  const dirs = new Set(list.body.items.map((x) => x.direction));
  assert.ok(dirs.has('input') && dirs.has('output'), '两个方向都要有');
});

await t('产物清单的租户/存在性边界：缺 sessionId → 400；不存在会话 → 404', async () => {
  const noArg = await call('GET', '/api/governance/artifacts', { token: adminToken });
  assert.equal(noArg.status, 400);
  const gone = await call('GET', '/api/governance/artifacts?sessionId=kb_不存在', { token: adminToken });
  assert.equal(gone.status, 404);
});

await t('viewer 无 artifact:read → 产物接口 403（治理面不豁免）', async () => {
  const r = await call('GET', '/api/governance/artifacts?sessionId=' + sessionId, { token: viewerToken });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'forbidden');
});

/**
 * 0.21.9 新增的「用系统默认程序打开产物」这条路，此前**一条 HTTP 用例都没有**
 * （只有服务层的路径提取 + 落库被测过）—— 覆盖对账把它抓了出来。
 *
 * 为什么它值得单独一组断言：它是这个项目里**唯一一处会把用户给的字符串交给
 * shell/进程创建**的接口。上面 `artifacts.mjs` 的注释把口径写得很清楚
 * （`spawn` + 数组传参 + `shell:false`，路径不当命令分隔符），但那是**注释**；
 * 注释不会在有人把 `spawn` 改成 `exec` 时变红。这组用例把它变成可执行的约束。
 *
 * ⚠️ 不真的开一个程序：这里只打**会先被服务端拒掉**的两档（空 path / 不存在），
 *    它们在任何机器上都稳定复现，且都不产生副作用。
 */
await t('打开产物：缺 path → 400；路径不存在 → 404（都不起进程）', async () => {
  const noPath = await call('POST', '/api/governance/artifacts/open', { token: adminToken, json: {} });
  assert.equal(noPath.status, 400, '缺 path 应 400，实际 ' + noPath.status);
  assert.ok(/path/.test(noPath.body.error.message), '错误消息要点名缺的是 path：' + noPath.body.error.message);

  const blank = await call('POST', '/api/governance/artifacts/open', { token: adminToken, json: { path: '   ' } });
  assert.equal(blank.status, 400, '全空白 path 与缺失同档（trim 后为空），实际 ' + blank.status);

  const ghost = path.join(tmp, '这个文件不存在-' + Date.now() + '.txt');
  const gone = await call('POST', '/api/governance/artifacts/open', { token: adminToken, json: { path: ghost } });
  assert.equal(gone.status, 404, '不存在的路径应 404（如实报，不静默成功），实际 ' + gone.status);
  assert.equal(gone.body.error.code, 'not_found');
});

await t('打开产物：无 artifact:read 的 viewer → 403（副作用动作不豁免）', async () => {
  const r = await call('POST', '/api/governance/artifacts/open', { token: viewerToken, json: { path: outPath } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'forbidden');
});

/**
 * 审计口径：这个接口是**有副作用**的（会在跑平台那台机器上起一个程序），
 * 所以它必须在动作**之前**落一条审计 —— 顺序反过来会让
 * "开了但审计还没写上"的那一瞬间存在，而那正是最该查的时候。
 *
 * 这里用不存在路径那条请求来验：它**不会**起进程，但路由层的 `audit.append` 写在
 * `openWithDefaultApp` 之前，所以审计里必须已经有一条 `artifact.open`。
 * ⚠️ 这恰好是这条顺序的一个可观测后果 —— 换成"先开再审计"，这条断言会红。
 */
await t('打开产物：审计在动作之前落（副作用动作的前置留痕）', async () => {
  const r = await call('GET', '/api/governance/audit?action=artifact.open&limit=50', { token: adminToken });
  assert.equal(r.status, 200);
  // ⚠️ 审计查询回的是**库行原样**（snake_case，`maskRow` 只脱敏 detail，不做驼峰转换）——
  //    这里写 `resource_id`，与库表列名一致。
  const items = (r.body && r.body.items) || [];
  assert.ok(items.length >= 1, 'audit 里应至少有一条 artifact.open（含上面那次 404 的前置留痕）');
  const hit = items.find((x) => String(x.resource_id || '').includes('这个文件不存在-'));
  assert.ok(hit, '404 那次请求也必须在审计里留下 path（resource_id），共 ' + items.length
    + ' 条，取到的 resource_id：' + JSON.stringify(items.map((x) => x.resource_id)));
  assert.equal(hit.resource_type, 'artifact');
  // 顺序证据：那条请求**报的是 404**（文件不存在），审计却在它执行之前就落下了 ——
  // 说明顺序是"先审计后动作"。若换成先开后审计，这一条在 404 路径上就查不到记录了。
  assert.equal(hit.result, 'ok', '审计写在动作之前，此时还不知道后一步会 404 —— 这是这条顺序的可观测后果');
});

await t('打开产物：路径不当命令分隔符（静态钉住 spawn + 数组传参 + shell:false）', async () => {
  // 这是整条接口里唯一真正的注入面。行为上无法在不起进程的前提下验证，
  // 所以钉**实现形式**本身：有人把 spawn 改成 exec、或把数组拼成字符串、或开 shell，
  // 这一条就红。这是"注释守不住的东西用断言守"。
  const src = fs.readFileSync(
    new URL('../app/platform/governance/artifacts.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function openWithDefaultApp'));
  assert.ok(fn.length > 0, '找不到 openWithDefaultApp 的实现 —— 断言会变成空转，必须红');
  assert.ok(/spawn\(/.test(fn), '必须用 spawn（不是 exec / execSync）');
  assert.ok(!/\bexec(Sync)?\(/.test(fn), '不许出现 exec/execSync —— 它会把路径交给 shell 解析');
  assert.ok(/shell:\s*false/.test(fn), '必须显式 shell:false');
  // 数组传参：路径永远走**独立一格**，不拼进命令字符串。
  assert.ok(/args\s*=\s*\[/.test(fn), '参数必须是数组（路径独立一格），不是拼接出来的字符串');
});

await t('会话日志 ZIP：真二进制、可解包、内容与库一致（元信息/事件/产物逐项核对）', async () => {
  const res = await fetch(BASE + '/api/governance/sessions/' + sessionId + '/log.zip',
    { headers: { authorization: 'Bearer ' + adminToken } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.ok((res.headers.get('content-disposition') || '').includes('.zip'), '应有下载头');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, '必须是真 ZIP（PK 头）');

  const entries = readZipEntries(buf);
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['artifacts.json', 'events.jsonl', 'meta.json', 'session.json']);
  const meta = JSON.parse(entries.find((e) => e.name === 'meta.json').data.toString('utf8'));
  assert.equal(meta.session.id, sessionId);
  assert.ok(meta.counts.events >= 8, '会话应已有落库事件（两轮对话 8 条 + 工具事件）');
  const eventsText = entries.find((e) => e.name === 'events.jsonl').data.toString('utf8');
  const lines = eventsText.trim().split('\n');
  assert.equal(lines.length, meta.counts.events, 'events.jsonl 行数与 meta 计数一致');
  JSON.parse(lines[0]);   // 每行都是合法 JSON（jsonl 纪律）
  const arts = JSON.parse(entries.find((e) => e.name === 'artifacts.json').data.toString('utf8'));
  assert.ok(arts.total >= 2, '产物清单应已随包导出');
});

await t('导出动作留审计（governance.sessionlog.export）', async () => {
  const hits = audit.list(orgId, { limit: 50 }).filter((a) => a.action === 'governance.sessionlog.export');
  assert.ok(hits.length >= 1, '导出必须落链');
  assert.equal(hits[hits.length - 1].result, 'ok');
});

/* ── 4.8 能力分发（M4-1：验收标准 1/2/3 的集成面）────────────────── */

section('能力分发：契约层 gate / 二级治理 / ZIP 安装 / MCP 探测');

await t('验收 1：deny 掉 MCP 服务后，契约层 listMcpServers 立即不再返回它（断言在契约层）', async () => {
  // ⚠️ 0.21.10：这条用例原来是"停用工具 → listTools 里消失"。工具不再是可登记的能力
  //    （没有清单、没有独立开关，由内核自己调用），治理面搬到了 MCP 服务上 ——
  //    契约层仍然要能被"立即掐掉"，所以钉子必须留着，只是钉在一个仍然存在的概念上。
  // 前置：登记一个 MCP 服务并让它出现在契约层清单里
  const mk = await call('POST', '/api/capability/mcp', { token: adminToken, json: { name: 'gate-demo', transport: 'http', config: { url: 'http://127.0.0.1:9' } } });
  assert.equal(mk.status, 200, '登记 MCP 服务应成功：' + JSON.stringify(mk.body));

  let listed = await kernel.provider.listMcpServers();
  assert.ok(listed.servers.some((x) => x.name === 'gate-demo'), '基线：gate-demo 应在契约层可见');
  assert.equal(listed.gatedBy, 'capability', '响应应标注 gate 来源');

  // 关键断言：直接调 provider（契约层），不是看 UI
  const set = await call('POST', '/api/capability/bindings', { token: adminToken, json: { capabilityType: 'server', capabilityId: 'gate-demo', allow: 0 } });
  assert.equal(set.status, 200);

  listed = await kernel.provider.listMcpServers();
  assert.ok(!listed.servers.some((x) => x.name === 'gate-demo'), 'deny 后契约层不得再返回 gate-demo');
  assert.ok(listed.blocked.some((x) => x.name === 'gate-demo' && x.reason === 'deny:server'),
    'blocked 里应如实给出原因 deny:server');

  // 备份：删掉绑定后恢复默认放行
  const pol = await call('GET', '/api/capability/policies', { token: adminToken });
  const row = pol.body.bindings.find((b) => b.capability_id === 'gate-demo' && b.subject_type === 'tenant');
  const del = await call('DELETE', '/api/capability/bindings/' + row.id, { token: adminToken });
  assert.equal(del.status, 200);
  listed = await kernel.provider.listMcpServers();
  assert.ok(listed.servers.some((x) => x.name === 'gate-demo'), '删绑定后恢复默认放行');

  await call('DELETE', '/api/capability/mcp/gate-demo', { token: adminToken });
});

await t('验收 2：二级 allow/deny 以数据形式生效，deny 永远赢，绑定可查可删（可 diff）', async () => {
  // ⚠️ 0.21.10：这里原来是四级穷举（含 tool 层）。现在只剩 server / connection 两级，
  //    而 connection 这一级在测试替身里没有真实的连接血缘可挂，所以只验 server 一级——
  //    **不为了凑层数去造一个假血缘**（那考的是测试自己编的结构，不是平台行为）。
  const mk = await call('POST', '/api/capability/mcp', { token: adminToken, json: { name: 'pol-demo', transport: 'http', config: { url: 'http://127.0.0.1:9' } } });
  assert.equal(mk.status, 200);

  // deny:server
  let set = await call('POST', '/api/capability/bindings', { token: adminToken, json: { capabilityType: 'server', capabilityId: 'pol-demo', allow: 0 } });
  assert.equal(set.status, 200);
  let listed = await kernel.provider.listMcpServers();
  assert.ok(listed.blocked.some((x) => x.name === 'pol-demo' && x.reason === 'deny:server'), 'deny:server 应立即生效');

  // 同一绑定改为 allow（覆盖语义）→ 恢复可见，且 reason 是 explicit_allow
  set = await call('POST', '/api/capability/bindings', { token: adminToken, json: { capabilityType: 'server', capabilityId: 'pol-demo', allow: 1 } });
  assert.equal(set.status, 200);
  listed = await kernel.provider.listMcpServers();
  assert.ok(listed.servers.some((x) => x.name === 'pol-demo'), 'allow 绑定后应恢复');
  const policiesNow = await call('GET', '/api/capability/policies', { token: adminToken });
  assert.equal(policiesNow.body.bindings.find((b) => b.capability_id === 'pol-demo' && b.subject_type === 'tenant').allow, 1);

  // 另一个主体（role）再补一条 deny：保守并集必须再次把服务掐掉（防跨主体泄漏）
  await call('POST', '/api/capability/bindings', { token: adminToken, json: { subjectType: 'role', subjectId: 'viewer', capabilityType: 'server', capabilityId: 'pol-demo', allow: 0 } });
  listed = await kernel.provider.listMcpServers();
  assert.ok(listed.blocked.some((x) => x.name === 'pol-demo' && x.reason === 'deny:server'), 'role 级 deny 也应进入保守并集');
  await call('DELETE', '/api/capability/bindings/' + (await call('GET', '/api/capability/policies', { token: adminToken })).body.bindings.find((b) => b.capability_id === 'pol-demo' && b.subject_type === 'role').id, { token: adminToken });

  // 绑定以数据形式存在：GET policies 能拿到全部行（可导出可 diff）
  const pol = await call('GET', '/api/capability/policies', { token: adminToken });
  assert.equal(pol.status, 200);
  const mine = pol.body.bindings.find((b) => b.capability_id === 'pol-demo' && b.subject_type === 'tenant');
  assert.ok(mine, 'pol-demo 的绑定应作为数据行可查');
  assert.equal(pol.body.stats.bindingsDeny + pol.body.bindings.filter((b) => b.allow === 1).length >= 1, true);

  // 坏输入：非法 allow 值 / 非法层级 → 400
  const bad = await call('POST', '/api/capability/bindings', { token: adminToken, json: { capabilityType: 'galaxy', capabilityId: 'x', allow: 0 } });
  assert.equal(bad.status, 400);
  // ⚠️ 已删除的层级必须**当场被拒**，而不是被静默收下写成一行死数据
  const gone = await call('POST', '/api/capability/bindings', { token: adminToken, json: { capabilityType: 'tool', capabilityId: 'stub.echo', allow: 0 } });
  assert.equal(gone.status, 400, 'tool 层已不存在，写绑定必须 400（不能静默收下）');

  // 清理：删绑定 + 删服务，回到默认状态
  const del = await call('DELETE', '/api/capability/bindings/' + mine.id, { token: adminToken });
  assert.equal(del.status, 200);
  listed = await kernel.provider.listMcpServers();
  assert.ok(listed.servers.some((x) => x.name === 'pol-demo'), '删绑定后恢复默认放行');

  const rm = await call('DELETE', '/api/capability/mcp/pol-demo', { token: adminToken });
  assert.equal(rm.status, 200);
});

await t('验收 3：ZIP 安装 Skill —— 好包真落盘；坏包 / 穿越包不落半成品且记审计', async () => {
  // 好 ZIP：现场构造（SKILL.md + assets/banner.txt）
  const goodZip = zipSync([
    { name: 'SKILL.md', data: Buffer.from('# 回归技能\n由 test-governance 现场构造', 'utf8') },
    { name: 'assets/banner.txt', data: Buffer.from('hello', 'utf8') },
  ]);
  const inst = await call('POST', '/api/capability/skills/install', { token: adminToken, json: { name: 'regression-skill', zipBase64: goodZip.toString('base64') } });
  assert.equal(inst.status, 200, '安装应成功：' + JSON.stringify(inst.body));
  assert.equal(inst.body.files, 2);
  const dest = inst.body.skill.path;
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')), '文件应真实落盘');
  assert.ok(fs.existsSync(path.join(dest, 'assets', 'banner.txt')), '子目录应被创建');
  const list = await call('GET', '/api/capability/skills', { token: adminToken });
  assert.ok(list.body.registry.some((s) => s.name === 'regression-skill'), '登记表应有记录');

  // 非法 ZIP → 400
  const junk = await call('POST', '/api/capability/skills/install', { token: adminToken, json: { name: 'junk', zipBase64: Buffer.from('这不是zip').toString('base64') } });
  assert.equal(junk.status, 400);

  // 路径穿越 ZIP → 400 + 审计 denied + 无半成品
  const evilZip = zipSync([{ name: '../evil.txt', data: Buffer.from('pwn', 'utf8') }]);
  const evil = await call('POST', '/api/capability/skills/install', { token: adminToken, json: { name: 'evil', zipBase64: evilZip.toString('base64') } });
  assert.equal(evil.status, 400);
  assert.match(evil.body.error.message, /路径穿越/);
  const evilHits = audit.list(orgId, { limit: 100 }).filter((a) => a.action === 'capability.skill.install' && a.result === 'denied');
  assert.ok(evilHits.length >= 1, '穿越尝试必须记审计（denied）');

  // 安装失败即回滚的另一半：登记行不存在（evil 从未登记）
  assert.ok(!list.body.registry.some((s) => s.name === 'evil'));
});

await t('清单接口不再下发工具段：registryTools / kernel.tools / toolsNote 一律不存在', async () => {
  // ⚠️ 0.21.10：这条用例原来是钉 `registryTools`「存在且是数组」的。工具不再是可登记的能力，
  //    于是钉子**反转**：这些字段必须**彻底消失**，而不是变成 `[]`。
  //    为什么必须反向钉：留一个恒空数组，前端无法分辨"清单为空"与"字段没给"，
  //    读起来就是"一个工具都没登记" —— 那是一句错的话（工具根本不需要登记）。
  const r = await call('GET', '/api/capability/skills', { token: adminToken });
  assert.equal(r.status, 200);
  for (const k of ['registryTools', 'toolsNote', 'toolsError']) {
    assert.ok(!(k in r.body), '响应里不应再有 ' + k + '：' + JSON.stringify(Object.keys(r.body)));
  }
  const k = r.body.kernel || {};
  assert.ok(!('tools' in k), 'kernel 段不应再有 tools');
  assert.ok(!('blocked' in k) || Array.isArray(k.blocked) === false || !k.tools,
    'kernel.blocked 若是 Skill 的 blocked，不得再夹带工具条目');
  // 该接口仍然要**如实**回答它现在负责什么：登记表 + Skill 内核探测 + 插件清单
  assert.ok(Array.isArray(r.body.registry), 'Skill 登记表仍要下发');
  assert.ok(Array.isArray(k.skills), 'kernel.skills 仍要下发（契约层可见的 Skill）');
  assert.equal(typeof k.pluginCount, 'number', '插件清单是**另一码事**，不能被工具一起删掉');
  // 权限面不变：viewer 照常可读（Skill 清单可读性不能因这次删除而收窄）
  const forViewer = await call('GET', '/api/capability/skills', { token: viewerToken });
  assert.equal(forViewer.status, 200, 'viewer 仍应可读');
  assert.ok(Array.isArray(forViewer.body.registry));
});

await t('工具启停路由已下线：POST /api/capability/tools/:name/enabled 必须是 404（不是 200 空操作）', async () => {
  // ⚠️ 0.21.10：路由整条删除，这里钉"它真的没了"。留一个恒 200 的空壳比删掉更坏 ——
  //    调用方会以为"启停成功了"，而实际上什么都没发生。
  const r = await call('POST', '/api/capability/tools/stub.echo/enabled', { token: adminToken, json: { enabled: false } });
  assert.equal(r.status, 404, '已删除的工具启停路由必须 404');
});

await t('MCP 登记（配置加密落库、不回显）+ 真实探测：可 / 不可 / stdio 缺命令，全部如实标注', async () => {
  // 起一个真实 TCP 监听，探测应得 ok
  const okServer = net.createServer();
  await new Promise((res) => okServer.listen(0, '127.0.0.1', res));
  const okPort = okServer.address().port;

  const up = await call('POST', '/api/capability/mcp', { token: adminToken, json: { name: 'probe-ok', transport: 'http', config: { url: 'http://127.0.0.1:' + okPort } } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const p1 = await call('POST', '/api/capability/mcp/probe-ok/probe', { token: adminToken });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.health, 'ok', '真实可达的端口必须探成 ok：' + p1.body.detail);

  // 不通的端口（port 1 几乎必然拒绝）→ error + 详情
  await call('POST', '/api/capability/mcp', { token: adminToken, json: { name: 'probe-bad', transport: 'http', config: { host: '127.0.0.1', port: 1 } } });
  const p2 = await call('POST', '/api/capability/mcp/probe-bad/probe', { token: adminToken });
  assert.equal(p2.body.health, 'error', '连不上必须如实报 error');
  assert.ok(/连接失败|拒绝|ECONNREFUSED/i.test(p2.body.detail), '失败详情要能看懂：' + p2.body.detail);

  // stdio：命令不存在 → error「命令未找到」（不假装 ok）
  await call('POST', '/api/capability/mcp', { token: adminToken, json: { name: 'probe-stdio', transport: 'stdio', config: { command: 'definitely-not-a-real-cmd-xyz' } } });
  const p3 = await call('POST', '/api/capability/mcp/probe-stdio/probe', { token: adminToken });
  assert.equal(p3.body.health, 'error');
  assert.match(p3.body.detail, /命令未找到/);

  // 清单：health 已更新；密文绝不回显
  const list = await call('GET', '/api/capability/mcp', { token: adminToken });
  assert.equal(list.status, 200);
  const row = list.body.registry.find((s) => s.name === 'probe-ok');
  assert.equal(row.health, 'ok');
  assert.equal(row.hasConfig, true);
  assert.ok(!('config_cipher' in row) && !row.configCipher, '响应不得携带密文（连密文都不回显）');

  // 加密回环：落库的是密文，用主密钥能解回原文
  const raw = caps.getMcpServer(orgId, 'probe-ok');
  assert.notEqual(raw.config_cipher, '');
  const plain = JSON.parse(decryptSecret(raw.config_cipher, masterSecret));
  assert.equal(plain.url, 'http://127.0.0.1:' + okPort);

  // 0.13.0：MCP 的启停与注销**终于有了出口** —— 此前路由层只能"登记 / 探测 / 列表"，
  // 一个挂掉的 MCP 既停不掉也删不掉（A2(b) 里"有实现没出口"的典型）。
  const dis = await call('PATCH', '/api/capability/mcp/probe-ok', { token: adminToken, json: { enabled: false } });
  assert.equal(dis.status, 200);
  assert.equal(dis.body.enabled, false);
  const afterOff = (await call('GET', '/api/capability/mcp', { token: adminToken })).body.registry.find((s) => s.name === 'probe-ok');
  assert.equal(afterOff.enabled, false, '停用必须真的落库');
  assert.equal(afterOff.health, 'ok', '停用**不**清健康历史 —— 那是"不用了"，不是"记录没了"');

  // 只认布尔：`'false'` 这类"看起来像假值"的东西一律 400。
  // 静默按真值处理会让"我明明传了 false 怎么还开着"变成一个查不出来的问题。
  const badBool = await call('PATCH', '/api/capability/mcp/probe-ok', { token: adminToken, json: { enabled: 'false' } });
  assert.equal(badBool.status, 400, "enabled 只认布尔，字符串 'false' 要 400");

  const reOn = await call('PATCH', '/api/capability/mcp/probe-ok', { token: adminToken, json: { enabled: true } });
  assert.equal(reOn.status, 200);
  assert.equal(reOn.body.enabled, true);

  // 不存在的服务 → 404（而不是"静默成功"，那会让调用方以为停掉了一个其实不存在的东西）
  const noSuchMcp = await call('PATCH', '/api/capability/mcp/no-such-mcp', { token: adminToken, json: { enabled: false } });
  assert.equal(noSuchMcp.status, 404);

  // 注销：返回 removed；**重复注销必须 404**，不能假装又删了一次
  const rmMcp = await call('DELETE', '/api/capability/mcp/probe-bad', { token: adminToken });
  assert.equal(rmMcp.status, 200);
  assert.equal(rmMcp.body.removed, true);
  const rmAgain = await call('DELETE', '/api/capability/mcp/probe-bad', { token: adminToken });
  assert.equal(rmAgain.status, 404, '重复注销要 404');

  okServer.close();
  // 清理：不留下影响后续用例的状态
  caps.removeMcpServer(orgId, 'probe-ok');
  caps.removeMcpServer(orgId, 'probe-bad');
  caps.removeMcpServer(orgId, 'probe-stdio');
  caps.unregisterSkill(orgId, 'regression-skill');
});

await t('M4-2 更新检测：unchanged / changed（目录被改动）/ missing（目录被删）全部如实', async () => {
  // 安装（带快照）
  const goodZip = zipSync([{ name: 'SKILL.md', data: Buffer.from('# 快照技能 v1', 'utf8') }]);
  const inst = await call('POST', '/api/capability/skills/install', { token: adminToken, json: { name: 'snapshot-skill', zipBase64: goodZip.toString('base64') } });
  assert.equal(inst.status, 200, JSON.stringify(inst.body));
  const dest = inst.body.skill.path;

  // 未动过 → unchanged
  let c = await call('POST', '/api/capability/skills/snapshot-skill/check-update', { token: adminToken });
  assert.equal(c.status, 200);
  assert.equal(c.body.status, 'unchanged', JSON.stringify(c.body));

  // 手动改文件 → changed（这就是"装进来的这份被改过"的检测）
  fs.writeFileSync(path.join(dest, 'SKILL.md'), '# 被人改过 v2', 'utf8');
  c = await call('POST', '/api/capability/skills/snapshot-skill/check-update', { token: adminToken });
  assert.equal(c.body.status, 'changed');
  assert.match(c.body.detail, /不一致/);

  // 目录被删 → missing
  fs.rmSync(dest, { recursive: true, force: true });
  c = await call('POST', '/api/capability/skills/snapshot-skill/check-update', { token: adminToken });
  assert.equal(c.body.status, 'missing');

  // 未登记的 → 404
  const nf = await call('POST', '/api/capability/skills/不存在/check-update', { token: adminToken });
  assert.equal(nf.status, 404);

  caps.unregisterSkill(orgId, 'snapshot-skill');
});

await t('E1 Skill 卸载（0.18.0）：zip 来源删目录 / 非落盘与越界只注销 / 未登记 404 / 审计恰好三条', async () => {
  // ① zip 来源：安装 → 卸载应连同安装目录删除
  const zip = zipSync([{ name: 'SKILL.md', data: Buffer.from('# 待卸载技能', 'utf8') }]);
  const inst = await call('POST', '/api/capability/skills/install', { token: adminToken, json: { name: 'uninstall-zip', zipBase64: zip.toString('base64') } });
  assert.equal(inst.status, 200, JSON.stringify(inst.body));
  const dest = inst.body.skill.path;
  assert.ok(fs.existsSync(dest), '前置：安装目录应存在');
  const del = await call('DELETE', '/api/capability/skills/uninstall-zip', { token: adminToken });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.removed, true);
  assert.equal(del.body.dirRemoved, true, 'zip 来源应删掉安装目录');
  assert.match(del.body.note, /删除/, 'note 要说明目录已删');
  assert.ok(!fs.existsSync(dest), '安装目录应真的没了');
  assert.equal(caps.getSkill(orgId, 'uninstall-zip'), undefined, '登记行应注销');
  // 重复卸载必须 404，不能假装又删了一次
  const again = await call('DELETE', '/api/capability/skills/uninstall-zip', { token: adminToken });
  assert.equal(again.status, 404, '重复卸载要 404');

  // ② 本机目录引用（local）：只注销登记，不碰用户目录
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-user-skill-'));
  fs.writeFileSync(path.join(userDir, 'SKILL.md'), '# 用户自己的目录', 'utf8');
  caps.registerSkill(orgId, { name: 'uninstall-local', source: 'local', path: userDir });
  const delLocal = await call('DELETE', '/api/capability/skills/uninstall-local', { token: adminToken });
  assert.equal(delLocal.status, 200);
  assert.equal(delLocal.body.dirRemoved, false, '非平台落盘来源不该删目录');
  assert.ok(fs.existsSync(path.join(userDir, 'SKILL.md')), '用户目录里的文件必须原样健在');
  assert.equal(caps.getSkill(orgId, 'uninstall-local'), undefined);
  fs.rmSync(userDir, { recursive: true, force: true });

  // ③ 越界：登记成 zip 但 path 在本租户 Skill 根目录之外 —— 安全边界，只注销不删
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-outside-'));
  fs.writeFileSync(path.join(outsideDir, 'SKILL.md'), '# 越界目录', 'utf8');
  caps.registerSkill(orgId, { name: 'uninstall-outside', source: 'zip', path: outsideDir });
  const delOut = await call('DELETE', '/api/capability/skills/uninstall-outside', { token: adminToken });
  assert.equal(delOut.status, 200);
  assert.equal(delOut.body.dirRemoved, false);
  assert.match(delOut.body.note, /不在本租户/, '越界路径要如实说明未删原因');
  assert.ok(fs.existsSync(path.join(outsideDir, 'SKILL.md')), '租户目录之外的路径必须原样保留');
  assert.equal(caps.getSkill(orgId, 'uninstall-outside'), undefined);
  fs.rmSync(outsideDir, { recursive: true, force: true });

  // ④ 未登记 → 404（handler 显式审计不落，只留收尾记录）
  const nf = await call('DELETE', '/api/capability/skills/no-such-skill-xyz', { token: adminToken });
  assert.equal(nf.status, 404);
  assert.match(nf.body.error.message, /未登记/);

  // ⑤ 审计：handler 显式记的三条（两条 ok + 一条 404 不记）一数不差；
  //    收尾记录用的是路由 id（capability.skills.remove，复数），不会混进这个过滤
  const rows = audit.list(orgId, { limit: 500 });
  const rms = rows.filter((x) => x.action === 'capability.skill.remove');
  assert.equal(rms.length, 3, '三次卸载应各留一条审计，实际 ' + rms.length);
  for (const x of rms) {
    assert.equal(x.result, 'ok');
    assert.equal(x.resource_type, 'skill');
  }
  const dById = Object.fromEntries(rms.map((x) => [x.resource_id, JSON.parse(x.detail_json)]));
  assert.equal(dById['uninstall-zip'].dirRemoved, true, 'zip 来源明细应记 dirRemoved=true');
  assert.equal(dById['uninstall-local'].dirRemoved, false);
  assert.equal(dById['uninstall-outside'].dirRemoved, false);
});

await t('验收 4 脱敏导出：MCP 连接密钥绝不出现；导出 JSON 经脚本模式扫描 0 凭据明文', async () => {
  // 布雷：登记一个带敏感配置的 MCP（密钥形状的值），导出里绝不能复现
  const SECRET_MARKERS = ['sk-live-9f8e7d6c5b4a', 'p@ssw0rd-super', 'ghp_abc123def456'];
  await call('POST', '/api/capability/mcp', { token: adminToken, json: {
    name: 'sensitive-mcp', transport: 'http',
    config: { url: 'https://internal.example.com', apiKey: SECRET_MARKERS[0], dbPassword: SECRET_MARKERS[1], botToken: SECRET_MARKERS[2] },
  } });

  const exp = await call('GET', '/api/capability/export', { token: adminToken });
  assert.equal(exp.status, 200);
  const exported = JSON.stringify(exp.body);

  // ① 已知明文逐一扫描 —— 一个都不许出现
  for (const marker of SECRET_MARKERS) {
    assert.ok(!exported.includes(marker), '导出里出现了凭据明文标记：' + marker);
  }
  // ② 字段名 + 值形状的模式扫描（对齐基线实现的打包扫描做法）
  const patterns = [
    /"config_cipher"\s*:\s*"(?!")/,            // 密文字段
    /"(apiKey|api_key|password|passwd|secret|token|botToken|dbPassword)"\s*:\s*"[^"]{4,}"/i, // 敏感字段带非空值
    /sk-[A-Za-z0-9]{8,}/,                       // OpenAI 形状
    /ghp_[A-Za-z0-9]{8,}/,                      // GitHub token 形状
  ];
  for (const p of patterns) {
    assert.ok(!p.test(exported), '导出 JSON 命中敏感模式 ' + p);
  }
  // ③ MCP 条目 config 必须是 null 且带说明
  const m = exp.body.mcp.find((x) => x.name === 'sensitive-mcp');
  assert.ok(m, 'MCP 条目应导出');
  assert.equal(m.config, null);
  assert.match(m.note, /不随清单导出/);

  caps.removeMcpServer(orgId, 'sensitive-mcp');
});

await t('导入回环：导出 → 清空 → 导入 → Skill 内容装回、绑定恢复、MCP 如实要求补配', async () => {
  // 布置：装一个 zip Skill + 一条 deny 绑定
  const zip = zipSync([{ name: 'SKILL.md', data: Buffer.from('# 回环技能', 'utf8') }]);
  const inst = await call('POST', '/api/capability/skills/install', { token: adminToken, json: { name: 'roundtrip-skill', zipBase64: zip.toString('base64') } });
  assert.equal(inst.status, 200);
  const bind = await call('POST', '/api/capability/bindings', { token: adminToken, json: { capabilityType: 'server', capabilityId: 'roundtrip-mcp', allow: 1 } });
  assert.equal(bind.status, 200, '绑定要挂在仍然存在的层上（0.21.10 起 tool 层已删除）');

  // 导出 → 清空
  const exp = await call('GET', '/api/capability/export', { token: adminToken });
  assert.equal(exp.status, 200);
  caps.unregisterSkill(orgId, 'roundtrip-skill');
  await call('DELETE', '/api/capability/bindings/' + bind.body.binding.id, { token: adminToken });
  assert.ok(!caps.getSkill(orgId, 'roundtrip-skill'), '清空后登记行应不存在');

  // 导入（附 MCP 条目，config 为 null —— 导入端如实接受并要求补配）
  const payload = exp.body;
  payload.mcp = [{ name: 'imported-mcp', transport: 'http', enabled: true, config: null, note: 'x' }];
  const imp = await call('POST', '/api/capability/import', { token: adminToken, json: payload });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.ok(imp.body.imported.skills.installed >= 1, 'Skill 应装回');
  assert.equal(imp.body.imported.skills.failed.length, 0);

  // 更名前形态的清单也必须能导入 —— 改名不许废掉"已经导出去的资产"。
  // （格式串改为**形态**校验的原因与代价写在 routes/capability.mjs 的注释里）
  const impLegacy = await call('POST', '/api/capability/import', {
    token: adminToken, json: { ...exp.body, format: 'legacy-name/capabilities' },
  });
  assert.equal(impLegacy.status, 200, '更名前形态的清单必须仍能导入：' + JSON.stringify(impLegacy.body));
  // 反向：放开的是"前缀形态"，不是"什么都收"
  const impBad = await call('POST', '/api/capability/import', {
    token: adminToken, json: { ...exp.body, format: 'random.json' },
  });
  assert.equal(impBad.status, 400, '形态不符必须 400');
  assert.equal(impBad.body.error.code, 'bad_request');

  // 验证恢复
  const back = caps.getSkill(orgId, 'roundtrip-skill');
  assert.ok(back, 'Skill 登记行恢复');
  assert.ok(fs.existsSync(path.join(back.path, 'SKILL.md')), 'Skill 内容真装回磁盘');
  const pol = await call('GET', '/api/capability/policies', { token: adminToken });
  assert.ok(pol.body.bindings.some((b) => b.capability_id === 'roundtrip-mcp' && b.allow === 1), '绑定恢复');
  const mc = caps.getMcpServer(orgId, 'imported-mcp');
  assert.ok(mc, 'MCP 条目恢复');
  assert.equal(mc.config_cipher, '', '导入的 MCP 无连接配置（要补配，不是假装配好了）');

  // 清理
  caps.unregisterSkill(orgId, 'roundtrip-skill');
  caps.removeMcpServer(orgId, 'imported-mcp');
  await call('DELETE', '/api/capability/bindings/' + pol.body.bindings.find((b) => b.capability_id === 'roundtrip-mcp').id, { token: adminToken });
  try { fs.rmSync(path.join(back.path), { recursive: true, force: true }); } catch { /* 已清 */ }
});

await t('权限：viewer 可读清单（矩阵 M1 起就授予的），但一切写操作 403 并告知 needs', async () => {
  // read：viewer 矩阵显式含 capability/skill/tool/mcp 的 read（permissions.mjs 90-100 行）
  for (const p of ['/api/capability/skills', '/api/capability/mcp', '/api/capability/policies']) {
    const r = await call('GET', p, { token: viewerToken });
    assert.equal(r.status, 200, 'GET ' + p + ' viewer 应可读');
  }
  // write：一律 403，needs 告知缺什么
  for (const [method, p, json] of [
    ['POST', '/api/capability/skills/install', { name: 'x', zipBase64: 'AAAA' }],
    // 工具启停路由已删除（0.21.10），这里换成仍然存在的写操作，别拿一条 404 冒充 403
    ['POST', '/api/capability/mcp', { name: 'x', transport: 'http', config: { url: 'http://127.0.0.1:9' } }],
    ['POST', '/api/capability/bindings', { capabilityType: 'server', capabilityId: 'x', allow: 0 }],
    ['DELETE', '/api/capability/bindings/nonexistent', undefined],
    ['DELETE', '/api/capability/skills/x', undefined],
  ]) {
    const r = await call(method, p, { token: viewerToken, json });
    assert.equal(r.status, 403, method + ' ' + p + ' 应回 403');
    assert.equal(r.body.error.code, 'forbidden');
    assert.ok(r.body.error.detail.needs.length >= 1, 'needs 要告知缺什么：' + JSON.stringify(r.body.error.detail));
  }
});

/* ── E2（0.18.0）：知识文档改名 ───────────────────────────────────── */

section('E2 文档改名：PATCH /api/knowledge/documents/:id（0.18.0）');

let renameKbId = null;
let renameDocId = null;

await t('改名成功：服务端 trim 后落库；chunkCount / status 不变（只动显示字段，不重新解析）', async () => {
  const mk = await call('POST', '/api/knowledge/bases', { token: adminToken, json: { name: '改名回归库' } });
  assert.equal(mk.status, 201, mk.text.slice(0, 200));
  renameKbId = mk.body.base.id;

  const up = await call('POST', '/api/knowledge/documents', {
    token: adminToken,
    json: { kbId: renameKbId, title: '改名前标题', text: '# 权限管理规范\n\n权限判定由纯函数实现，未知角色一律拒绝。\n\n# 审批流程\n\n报销需三人审批。' },
  });
  assert.equal(up.status, 201, up.text.slice(0, 300));
  renameDocId = up.body.document.id;
  const chunksBefore = up.body.document.chunkCount;
  assert.equal(up.body.document.status, 'ready');
  assert.ok(chunksBefore >= 1, '前置：解析应产出分块');

  const r = await call('PATCH', '/api/knowledge/documents/' + renameDocId, {
    token: adminToken, json: { title: '  改名后的标题  ' },
  });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.body.document.title, '改名后的标题', '服务端应 trim 后再存');
  assert.equal(r.body.document.chunkCount, chunksBefore, '改名不得碰分块');
  assert.equal(r.body.document.status, 'ready', '改名不得触发重新解析');

  // 回读：单文档与列表都回新标题
  const one = await call('GET', '/api/knowledge/documents/' + renameDocId, { token: adminToken });
  assert.equal(one.body.document.title, '改名后的标题');
  const list = await call('GET', '/api/knowledge/bases/' + renameKbId + '/documents', { token: adminToken });
  assert.equal(list.body.items.find((x) => x.id === renameDocId).title, '改名后的标题');
});

await t('入参边界：空串 / 全空格 / 超长 / 非字符串 400；未登记文档 404', async () => {
  const empty = await call('PATCH', '/api/knowledge/documents/' + renameDocId, { token: adminToken, json: { title: '' } });
  assert.equal(empty.status, 400, '空串应 400');
  assert.ok(empty.body.error.detail.fields.some((f) => f.field === 'title' && /缺少必填字段/.test(f.message)));

  const blank = await call('PATCH', '/api/knowledge/documents/' + renameDocId, { token: adminToken, json: { title: '   ' } });
  assert.equal(blank.status, 400, '全空格 trim 后为空 → 服务层拒');
  assert.match(blank.body.error.message, /不能为空/);

  const long = await call('PATCH', '/api/knowledge/documents/' + renameDocId, { token: adminToken, json: { title: '长'.repeat(301) } });
  assert.equal(long.status, 400, '超长要在最浅一层被拦');
  assert.ok(long.body.error.detail.fields.some((f) => /300/.test(f.message)));

  const notStr = await call('PATCH', '/api/knowledge/documents/' + renameDocId, { token: adminToken, json: { title: 12345 } });
  assert.equal(notStr.status, 400);
  assert.ok(notStr.body.error.detail.fields.some((f) => /必须是字符串/.test(f.message)));

  const nf = await call('PATCH', '/api/knowledge/documents/doc_no_such_xyz', { token: adminToken, json: { title: '随便' } });
  assert.equal(nf.status, 404, '未登记文档应 404（存在性不泄漏）');
});

await t('权限：未登录 401；viewer 可读租户库但只有 read 档 → 服务层 403', async () => {
  const anon = await call('PATCH', '/api/knowledge/documents/' + renameDocId, { json: { title: 'x' } });
  assert.equal(anon.status, 401);

  const v = await call('PATCH', '/api/knowledge/documents/' + renameDocId, { token: viewerToken, json: { title: 'x' } });
  assert.equal(v.status, 403, '租户可见库 + viewer 只有 read 档 → 403');
  assert.equal(v.body.error.code, 'forbidden');
  assert.match(v.body.error.message, /没有该操作的权限/, '服务层判定（档位 read < write）');
});

await t('审计：handler 显式记录 knowledge.document.rename 恰好一条（含 trim 后标题与库 id）', async () => {
  const rows = audit.list(orgId, { limit: 500 });
  const renames = rows.filter((x) => x.action === 'knowledge.document.rename');
  assert.equal(renames.length, 1, '改名成功一次应恰留一条显式审计，实际 ' + renames.length);
  const r = renames[0];
  assert.equal(r.result, 'ok');
  assert.equal(r.resource_type, 'document');
  assert.equal(r.resource_id, renameDocId);
  const d = JSON.parse(r.detail_json);
  assert.equal(d.title, '改名后的标题', '审计要记 trim 后的最终值');
  assert.equal(d.kbId, renameKbId);
});

/* ── E3（0.18.0）：备份文件删除 ───────────────────────────────────── */

// 放在这里而不是文件后半的「备份与恢复」段，原因有二：
//   ① 覆盖面清单（下文）要求每个动作类型都已有真实记录，删除动作必须在清单核对**之前**跑过；
//   ② 此刻套件尚未创建过任何备份，backups 目录从零开始 —— remaining 可以精确到个位数。
section('E3 备份删除：DELETE /api/operation/backup/:file（0.18.0）');

let e3KeepName = null;

await t('删除成功：只动点名的那一份；remaining 如实递减；64-hex 侧车连带清理', async () => {
  const dir = path.join(tmp, 'backups');
  const b1 = await call('POST', '/api/operation/backup', { token: adminToken });
  const b2 = await call('POST', '/api/operation/backup', { token: adminToken });
  assert.equal(b1.status, 200, b1.text.slice(0, 200));
  assert.equal(b2.status, 200, b2.text.slice(0, 200));
  assert.notEqual(b1.body.file, b2.body.file, '两次备份落在同一毫秒是异常（后一份会覆盖前一份）——先查这个再怪 remaining');
  e3KeepName = b1.body.file;

  // API 备份走统一密钥、本不带侧车；手工造一个 64-hex 侧车（一次性密钥的真实形态），
  // 验证「连带清理」的口径与轮转（pruneBackups）完全一致。
  const sidecar = path.join(dir, b2.body.file.replace(/\.zip$/, '.key'));
  fs.writeFileSync(sidecar, 'a'.repeat(64));

  const r = await call('DELETE', '/api/operation/backup/' + encodeURIComponent(b2.body.file), { token: adminToken });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.body.name, b2.body.file);
  assert.ok(r.body.bytes > 0, '要回真实释放字节数');
  assert.equal(r.body.freedKey, true, '64-hex 侧车必须连带清理');
  assert.equal(r.body.remaining, 1, '目录里应恰剩 1 份 backup-*.zip');
  assert.ok(!fs.existsSync(path.join(dir, b2.body.file)), '点名的文件必须真的被删');
  assert.ok(!fs.existsSync(sidecar), '64-hex 侧车必须真的被删');
  assert.ok(fs.existsSync(path.join(dir, e3KeepName)), '没点名的备份一律不许碰');

  // 审计：handler 恰一条。⚠️ 本路由 id 与动作名同串（都是 operation.backup.remove），
  // 收尾中间件还会落一条 resource_type='route' 的行 —— 必须按 resource_type 区分，
  // 否则两条同串记录会让"恰一条"的断言时红时绿。
  const handlerRows = audit.query(orgId, { action: 'operation.backup.remove', limit: 10 }).items
    .filter((x) => x.resource_type === 'backup' && x.resource_id === b2.body.file);
  assert.equal(handlerRows.length, 1, '删除成功应恰留一条 handler 审计，实际 ' + handlerRows.length);
  assert.equal(handlerRows[0].result, 'ok');
  const d = JSON.parse(handlerRows[0].detail_json);
  assert.equal(d.bytes, r.body.bytes);
  assert.equal(d.freedKey, true);
  assert.equal(d.remaining, 1);
});

await t('非 64-hex 的同名 .key 不动：只删备份主干，不碰来历不明的文件', async () => {
  const dir = path.join(tmp, 'backups');
  const b3 = await call('POST', '/api/operation/backup', { token: adminToken });
  assert.equal(b3.status, 200, b3.text.slice(0, 200));
  const junkSidecar = path.join(dir, b3.body.file.replace(/\.zip$/, '.key'));
  fs.writeFileSync(junkSidecar, 'not-a-real-key');

  const r = await call('DELETE', '/api/operation/backup/' + encodeURIComponent(b3.body.file), { token: adminToken });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.body.freedKey, false, '形态不符的 .key 不算一次性密钥侧车');
  assert.equal(r.body.remaining, 1);
  assert.ok(!fs.existsSync(path.join(dir, b3.body.file)), '主干必须被删');
  assert.ok(fs.existsSync(junkSidecar), '形态不符的同名 .key 不许被碰');
  fs.rmSync(junkSidecar, { force: true });     // 清手工文件，不给后面「备份列表」段留噪音
});

await t('绝不删最后一份：409 conflict，文件原封不动（磁盘满是问题，没有备份是灾难）', async () => {
  const dir = path.join(tmp, 'backups');
  assert.ok(fs.existsSync(path.join(dir, e3KeepName)), '前置：此刻应恰剩这一份');
  const r = await call('DELETE', '/api/operation/backup/' + encodeURIComponent(e3KeepName), { token: adminToken });
  assert.equal(r.status, 409, r.text.slice(0, 200));
  assert.equal(r.body.error.code, 'conflict');
  assert.match(r.body.error.message, /最后一份/);
  assert.ok(fs.existsSync(path.join(dir, e3KeepName)), '拒绝后文件必须仍在盘上');

  const q = () => audit.query(orgId, { action: 'operation.backup.remove', limit: 20 }).items;
  const forName = q().filter((x) => x.resource_type === 'backup' && x.resource_id === e3KeepName);
  assert.equal(forName.length, 0, '被护栏拦下的删除不该产生 handler 行');
  const atRoute = q().filter((x) => {
    try { return x.resource_type === 'route' && JSON.parse(x.detail_json).status === 409; } catch { return false; }
  });
  assert.equal(atRoute.length, 1, '拒绝同样要留痕（收尾行记 status=409），实际 ' + atRoute.length);
});

await t('形态白名单：非 backup-*.zip 形态一律拒（400）；不存在的 404', async () => {
  const dir = path.join(tmp, 'backups');
  const junk = path.join(dir, 'notes.zip');
  fs.writeFileSync(junk, 'definitely not a backup');
  const shape = await call('DELETE', '/api/operation/backup/notes.zip', { token: adminToken });
  assert.equal(shape.status, 400, shape.text.slice(0, 200));
  assert.equal(shape.body.error.code, 'bad_request');
  assert.match(shape.body.error.message, /backup-.*\.zip|形态/);
  assert.ok(fs.existsSync(junk), '被白名单拒的文件不许被碰');
  fs.rmSync(junk, { force: true });

  const nf = await call('DELETE', '/api/operation/backup/backup-nope-19700101.zip', { token: adminToken });
  assert.equal(nf.status, 404, nf.text.slice(0, 200));
  assert.equal(nf.body.error.code, 'not_found');
});

await t('权限：未登录 401；viewer 无 operation:delete → 403 needs 精确、拒绝留痕', async () => {
  const anon = await call('DELETE', '/api/operation/backup/' + encodeURIComponent(e3KeepName), {});
  assert.equal(anon.status, 401, '未登录不许摸运维面');

  const v = await call('DELETE', '/api/operation/backup/' + encodeURIComponent(e3KeepName), { token: viewerToken });
  assert.equal(v.status, 403, v.text.slice(0, 200));
  assert.equal(v.body.error.code, 'forbidden');
  assert.deepEqual(v.body.error.detail.needs, ['operation:delete']);

  // 验收标准 3：权限拒绝同样留痕（rbac 的 access.denied，含 needs）
  const denied = audit.list(orgId, { limit: 500 }).filter((x) => {
    if (x.action !== 'access.denied') return false;
    try { return JSON.parse(x.detail_json).needs.includes('operation:delete'); } catch { return false; }
  });
  assert.ok(denied.length >= 1, 'viewer 试探删除备份被拒，必须留 access.denied');
});

section('审计接口与哈希链校验');

await t('审计查询支持过滤（result=denied / action 前缀）', async () => {
  const r = await call('GET', '/api/governance/audit?result=denied&limit=50', { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length >= 2, '至少有 rbac/quota 的 denied 记录，实际 ' + r.body.items.length);
  assert.ok(r.body.items.every((x) => x.result === 'denied'));
  assert.ok(r.body.items.every((x) => !x.detail_json), '响应里不应再带原始 detail_json（已解析为 detail）');

  const g = await call('GET', '/api/governance/audit?action=governance.&limit=100', { token: adminToken });
  assert.ok(g.body.items.length >= 3);
  assert.ok(g.body.items.every((x) => /^governance\./.test(x.action)), 'action 前缀过滤要生效');
  assert.ok(g.body.latestHash, '要返回链尾哈希');
});

await t('verify：未篡改 → ok（验收标准 1 前半）', async () => {
  const r = await call('POST', '/api/governance/audit/verify', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.verify.ok, true);
  assert.equal(r.body.verify.checked, r.body.verify.total);
  assert.ok(r.body.verify.checked >= 10, '此前用例应已产生至少 10 条审计');
});

await t('人为改一行 → verify 定位到那条；删一行同理；复原后恢复绿（验收标准 1 后半）', async () => {
  const rows = audit.list(orgId, { limit: 500 });
  const victim = rows[rows.length - 5];       // 倒数第 5 条（较早，链还在它后面延续）
  const victimOriginal = victim.result;       // ⚠️ 复原必须用原值 —— 想当然写 'ok' 会把 denied 改坏
  db.run('UPDATE audit_logs SET result = ? WHERE id = ?', ['tampered', victim.id]);

  const r = await call('POST', '/api/governance/audit/verify', { token: adminToken });
  assert.equal(r.body.verify.ok, false);
  assert.equal(r.body.verify.brokenAt.id, victim.id, '断裂点必须是**被改的那条**');
  assert.ok(r.body.note.includes('断裂'));

  // 复原 → 重新绿（证明"红"不是接口坏了）
  db.run('UPDATE audit_logs SET result = ? WHERE id = ?', [victimOriginal, victim.id]);

  // 删行也一样能被定位（链上出现"凭空缺口"）；删之前把整行存下来用于复原
  const rows2 = audit.list(orgId, { limit: 500 });
  const victim2 = rows2[rows2.length - 8];
  const snapshot = { ...victim2 };
  db.run('DELETE FROM audit_logs WHERE id = ?', [victim2.id]);
  const r2 = await call('POST', '/api/governance/audit/verify', { token: adminToken });
  assert.equal(r2.body.verify.ok, false, '删行后链必须断');

  db.run(
    `INSERT INTO audit_logs (id, tenant_id, user_id, action, resource_type, resource_id, result, detail_json, prev_hash, hash, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [snapshot.id, snapshot.tenant_id, snapshot.user_id, snapshot.action, snapshot.resource_type,
      snapshot.resource_id, snapshot.result, snapshot.detail_json, snapshot.prev_hash, snapshot.hash, snapshot.at]
  );
  const r3 = await call('POST', '/api/governance/audit/verify', { token: adminToken });
  assert.equal(r3.body.verify.ok, true, '删行复原后应重新通过');
});

await t('审计收尾中间件：状态变更请求自动落链（含耗时）', async () => {
  const r = await call('POST', '/api/governance/quotas', {
    token: adminToken,
    json: { subjectType: 'tenant', metric: 'output_tokens', period: 'month', limitValue: 100000, mode: 'block' },
  });
  assert.equal(r.status, 201);
  const rows = audit.list(orgId, { limit: 20 });
  const fin = rows.find((x) => x.action === 'governance.quotas.upsert' && x.result === 'ok');
  assert.ok(fin, '配额写入应有一条审计（handler 显式写的）');
  // 收尾记录：同一路由 id、detail.finalized=true、带 status/elapsedMs
  const fin2 = rows.filter((x) => x.action === 'governance.quotas.upsert' && (() => { try { return JSON.parse(x.detail_json).finalized; } catch { return false; } })());
  assert.ok(fin2.length >= 1, 'audit 中间件的收尾记录必须存在');
  const d = JSON.parse(fin2[0].detail_json);
  assert.equal(d.status, 201);
  assert.ok(Number.isFinite(d.elapsedMs), '收尾要记耗时');
  assert.equal(d.method, 'POST');
});

await t('审计收尾：GET 成功不落链（信噪比纪律）；GET 被 403 拒时由 rbac 留痕', async () => {
  const beforeRows = audit.list(orgId, { limit: 500 });
  const beforeCount = audit.count(orgId);
  await call('GET', '/api/governance/quotas', { token: adminToken });          // 200 GET → 不记
  assert.equal(audit.count(orgId), beforeCount, 'GET 成功不应写审计链');

  // 403 发生在 rbac（链在 audit 中间件之前就 stop 了），所以留痕责任在 rbac：
  // 它写 access.denied —— 这条纪律不能变成"两条都记"的重复噪声。
  await call('GET', '/api/governance/audit?action=zzz-no-such-prefix', { token: viewerToken });
  const afterRows = audit.list(orgId, { limit: 500 });
  assert.equal(afterRows.length, beforeRows.length + 1,
    '只应有 rbac 的一条 access.denied（收尾器不重复记被前置中间件拦掉的请求）');
  const denied = afterRows.find((x) => x.action === 'access.denied'
    && JSON.parse(x.detail_json).needs && JSON.parse(x.detail_json).needs.includes('audit:read'));
  assert.ok(denied, 'rbac 要记下"探测 audit 接口被拒"（needs=audit:read）');
});

/* ── 6. 审计覆盖面（验收标准 2）──────────────────────────────────── */

section('审计覆盖面：清单里每个动作类型都有真实记录');

await t('覆盖面清单逐项断言（清单写在测试里，漏一个就红）', async () => {
  const org = audit.list(orgId, { limit: 500 });
  const anon = audit.list(audit.ANONYMOUS_TENANT, { limit: 500 });
  const all = [...org, ...anon];
  const actions = new Set(all.map((a) => a.action));
  const REQUIRED = [
    'auth.authenticate',        // 未登录被拒（M1）
    'access.denied',            // rbac 越权（M1）
    'identity.user.create',     // 建用户（M1）
    'governance.quota.upsert',  // 配额写入（M3）
    'governance.quota.block',   // 配额拦截（M3，验收 3）
    'governance.quota.warn',    // 配额提醒（M3）
    'governance.audit.verify',  // 审计校验（M3）
    'governance.sessionlog.export', // 会话日志导出（M4-0 产物留存）
    'capability.skill.remove',  // Skill 卸载（0.18.0，E1）
    'knowledge.document.rename', // 文档改名（0.18.0，E2）
    'operation.backup.remove',   // 备份删除（0.18.0，E3）
  ];
  const missing = REQUIRED.filter((a) => !actions.has(a));
  assert.deepEqual(missing, [], '以下动作类型没有产生任何审计记录：' + missing.join(', '));

  // 拒绝类的 result 必须是 denied（语义纪律）
  for (const a of ['governance.quota.block', 'access.denied']) {
    const hit = all.filter((x) => x.action === a);
    assert.ok(hit.every((x) => x.result === 'denied'), a + ' 的 result 必须全部是 denied');
  }
  assert.ok(all.every((x) => ['ok', 'denied', 'error'].includes(x.result)), 'result 只允许 ok/denied/error');
});

/* ── 8. 备份与恢复（M5）：在线备份 / 校验 / 离线恢复自证 ─────────── */

section('备份与恢复：在线备份 / 校验 / 离线恢复自证');

await t('权限：viewer 无 operation:write，创建备份 403 并告知 needs', async () => {
  const r = await call('POST', '/api/operation/backup', { token: viewerToken });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'forbidden');
  assert.deepEqual(r.body.error.detail.needs, ['operation:write']);
});

await t('备份列表（P0-D 新增只读接口）：如实列出 backups 目录；viewer 无 operation:read → 403', async () => {
  // viewer 连只读的备份列表都不该看到（备份文件属于平台级运维面）
  const nope = await call('GET', '/api/operation/backup', { token: viewerToken });
  assert.equal(nope.status, 403, 'viewer 应被拒，实际 ' + nope.status);

  const created = await call('POST', '/api/operation/backup', { token: adminToken });
  assert.equal(created.status, 200);

  const list = await call('GET', '/api/operation/backup', { token: adminToken });
  assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 200));
  assert.ok(Array.isArray(list.body.items), 'items 必须是数组');
  const hit = list.body.items.find((x) => x.file === created.body.file);
  assert.ok(hit, '刚创建的备份必须出现在列表里');
  assert.ok(hit.bytes > 0, '要有真实字节数');
  assert.match(hit.mtime, /^\d{4}-\d\d-\d\dT/, '要有 ISO 修改时间');
  // 按修改时间倒序（前端列表直接照序渲染）
  const times = list.body.items.map((x) => x.mtime);
  assert.deepEqual(times, [...times].sort().reverse(), '列表应按修改时间倒序');
});

await t('在线备份：VACUUM INTO 快照 + 存储打包 + manifest；主密钥绝不进包', async () => {
  const r = await call('POST', '/api/operation/backup', { token: adminToken });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const m = r.body.manifest;
  assert.equal(m.format, 'sti-harness/backup');
  assert.equal(m.formatVersion, 2);
  assert.match(m.db.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(m.storage.fileCount >= 1, 'storage 里应有 uploads/artifacts 文件（测试装配写过文件）');
  assert.match(m.secret, /NOT_INCLUDED/, 'manifest 要显式写明主密钥不在包里');
  assert.ok(m.encryption && m.encryption.kid && m.signature && m.signature.value,
    'v2 必须带加密块（含 kid）与 manifest 签名');

  // 备份文件真实存在、ZIP 条目齐全；条目名里不能出现 .secret
  const backupFile = path.join(tmp, 'backups', r.body.file);
  assert.ok(fs.existsSync(backupFile), '备份文件应落在 DATA_DIR/backups');
  const entries = readZipEntries(fs.readFileSync(backupFile));
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('manifest.json') && names.includes('sti-harness.db.enc'),
    '包里要有 manifest 与加密 db：' + names.join(','));
  assert.ok(!names.includes('sti-harness.db'), '明文 db 不许进包');
  assert.ok(names.filter((n) => n.startsWith('storage/')).every((n) => n.endsWith('.enc')),
    'storage 条目必须全部加密');
  assert.ok(!names.some((n) => n.includes('.secret')), '主密钥绝不进备份包：' + names.join(','));

  // 审计已留痕（query 按 action 前缀过滤，再精确匹配排除 .verify）
  const hits = audit.query(orgId, { action: 'operation.backup', limit: 10 }).items
    .filter((x) => x.action === 'operation.backup');
  assert.ok(hits.length >= 1, '备份动作要落审计链');
});

await t('备份校验：API 校验通过；篡改任一文件后逐文件定位问题', async () => {
  // 先造一个已知的 storage 文件再备份，篡改它的内容
  const seedDir = path.join(tmp, 'storage', 'uploads');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(path.join(seedDir, 'backup-probe.txt'), 'restore-probe-' + Date.now());

  const created = await call('POST', '/api/operation/backup', { token: adminToken });
  assert.equal(created.status, 200);
  const backupFile = path.join(tmp, 'backups', created.body.file);

  // 正常校验走 API
  const v = await call('POST', '/api/operation/backup/verify', { token: adminToken, json: { file: created.body.file } });
  assert.equal(v.status, 200);
  assert.equal(v.body.ok, true, '完整包应通过校验：' + JSON.stringify(v.body.problems));
  assert.ok(v.body.checked >= 3, '至少 manifest+db+1 个 storage 文件');

  // 篡改：把加密 db 条目的一个字节改掉 → GCM tag 校验失败，报「解密失败」且指名道姓
  const DB_ENC = 'sti-harness.db.enc';
  const entries = readZipEntries(fs.readFileSync(backupFile));
  const tampered = entries.map((e) => {
    if (e.name === DB_ENC) {
      const d = Buffer.from(e.data);
      d[40] = d[40] ^ 0xff;
      return { name: e.name, data: d };
    }
    return { name: e.name, data: e.data };
  });
  const badFile = path.join(tmp, 'backups', 'tampered.zip');
  fs.writeFileSync(badFile, zipSync(tampered));
  const { verifyBackup } = await import('../app/platform/operation/backup.mjs');
  const verdict = verifyBackup(badFile, { key: BACKUP_KEY });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((x) => x.includes(DB_ENC) && x.includes('解密失败')),
    '要精确指认被篡改的加密文件：' + JSON.stringify(verdict.problems));

  // 审计留痕（成功校验记 ok）
  const hits = audit.query(orgId, { action: 'operation.backup.verify', limit: 10 }).items;
  assert.ok(hits.some((x) => x.result === 'ok'), '成功校验要留痕');
});

await t('旧版（formatVersion 1，更名前形态）备份包：仍可校验通过，恢复出来落成**规范名**（升级不废历史备份）', async () => {
  const { verifyBackup, restoreBackup, decryptEntry, backupKeyInfo } = await import('../app/platform/operation/backup.mjs');

  // 先建 v2 加密备份，作为解密还原明文的素材
  const created = await call('POST', '/api/operation/backup', { token: adminToken });
  assert.ok(created.body && created.body.file, '先要能建出备份：' + created.status);
  const src = path.join(tmp, 'backups', created.body.file);
  const v2EntriesAll = readZipEntries(fs.readFileSync(src));
  const v2ByName = new Map(v2EntriesAll.map((e) => [e.name, e.data]));
  const v2m = JSON.parse(v2ByName.get('manifest.json').toString('utf8'));

  // 用测试密钥派生 encKey，解密出明文
  const master = Buffer.from(BACKUP_KEY, 'hex');
  const encKey = Buffer.from(crypto.hkdfSync('sha256', master, 'sti-harness/backup/v2',
    'sti-harness/backup/enc/v1', 32));

  // 手工组装一个**真正的 v1 明文包** —— 这才是历史版本产物的真实样子：
  // format 用旧前缀、库条目用旧名、明文哈希、无 encryption/signature。
  const legacyName = 'legacy-name.db';
  const v1Entries = [{ name: legacyName, data: decryptEntry(v2ByName.get(v2m.db.entry), encKey) }];
  for (const f of v2m.storage.files) {
    v1Entries.push({ name: f.name, data: decryptEntry(v2ByName.get(f.entry), encKey) });
  }
  const v1m = {
    format: 'legacy-name/backup',
    formatVersion: 1,
    platformVersion: v2m.platformVersion,
    createdAt: v2m.createdAt,
    label: v2m.label,
    db: { bytes: v2m.db.bytes, sha256: v2m.db.sha256 },
    storage: {
      fileCount: v2m.storage.fileCount, bytes: v2m.storage.bytes,
      files: v2m.storage.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
    },
    secret: v2m.secret,
  };
  v1Entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(v1m, null, 2)) });

  const legacyFile = path.join(tmp, 'backups', 'legacy-shaped.zip');
  fs.writeFileSync(legacyFile, zipSync(v1Entries));

  // v1 包无需密钥即可校验
  const v = verifyBackup(legacyFile);
  assert.equal(v.ok, true, '旧版形态的包必须仍被接纳：' + JSON.stringify(v.problems));
  assert.equal(v.encrypted, false);
  assert.ok(backupKeyInfo(BACKUP_KEY), '密钥指纹工具应可用');

  // 恢复必须落成**规范名**：否则"恢复成功"却留下一个下个版本自己都认不出的库文件
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-legacy-restore-'));
  const r = restoreBackup({ backupFile: legacyFile, destDataDir: dest });
  assert.equal(r.restored.db, true, '恢复要报 db 已恢复');
  assert.ok(fs.existsSync(path.join(dest, 'sti-harness.db')), '恢复出来必须是规范名');
  assert.ok(!fs.existsSync(path.join(dest, legacyName)), '不许把旧名库文件留在目标目录');

  // ── 反向控制：放开的是"旧版兼容"，不是"什么都收" ──────────────
  const withFormat = (fmt) => v1Entries.map((e) => {
    if (e.name !== 'manifest.json') return { name: e.name, data: e.data };
    const m = JSON.parse(e.data.toString('utf8'));
    m.format = fmt;
    return { name: e.name, data: Buffer.from(JSON.stringify(m, null, 2)) };
  });
  const f1 = path.join(tmp, 'backups', 'bad-format.zip');
  fs.writeFileSync(f1, zipSync(withFormat('random.zip')));
  assert.equal(verifyBackup(f1).ok, false, 'format 形态不符必须拒');

  const f2 = path.join(tmp, 'backups', 'no-db-entry.zip');
  fs.writeFileSync(f2, zipSync(v1Entries.map((e) => (e.name === legacyName ? { name: 'db.txt', data: e.data } : { name: e.name, data: e.data }))));
  const v2v = verifyBackup(f2);
  assert.equal(v2v.ok, false, '包里没有 *.db 条目必须拒');
  assert.ok(v2v.problems.some((x) => x.includes('没有库文件')), '要说清是缺库文件：' + JSON.stringify(v2v.problems));

  const f3 = path.join(tmp, 'backups', 'two-db.zip');
  fs.writeFileSync(f3, zipSync(v1Entries.concat([{ name: 'another.db', data: Buffer.from('x') }])));
  const v3 = verifyBackup(f3);
  assert.equal(v3.ok, false, '两个库条目必须拒（本工具不替人挑）');
  assert.ok(v3.problems.some((x) => x.includes('多个库文件')), '要说清是"无法判定"：' + JSON.stringify(v3.problems));
});

await t('离线恢复：备份 → 清库 → 恢复 → 行数与内容一致（验收标准 1 的迷你闭环）', async () => {
  const { restoreBackup } = await import('../app/platform/operation/backup.mjs');

  // 备份前的行数快照（orgs 是本套件建过的业务表）
  const orgsBefore = db.all('SELECT id, name FROM orgs ORDER BY id').map((r) => r.id);

  const created = await call('POST', '/api/operation/backup', { token: adminToken });
  const backupFile = path.join(tmp, 'backups', created.body.file);

  // 恢复到全新目录：防误覆盖必须生效（先放一个占位库文件再试）
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-restore-'));
  fs.writeFileSync(path.join(dest, 'sti-harness.db'), 'not-a-real-db');
  assert.throws(() => restoreBackup({ backupFile, destDataDir: dest, key: BACKUP_KEY }), /overwrite/,
    '目标已有库且未传 overwrite 时必须拒绝');
  const r = restoreBackup({ backupFile, destDataDir: dest, overwrite: true, key: BACKUP_KEY });
  assert.equal(r.restored.db, true);
  assert.ok(fs.existsSync(path.join(dest, 'sti-harness.db')));
  assert.ok(!fs.existsSync(path.join(dest, '.secret')), '恢复不产生主密钥（它本就不在包里）');

  // 用只读连接验证恢复后的库：orgs 行集与备份前逐行一致
  const { DatabaseSync } = await import('node:sqlite');
  const check = new DatabaseSync(path.join(dest, 'sti-harness.db'), { readOnly: true });
  try {
    const orgsAfter = check.prepare('SELECT id, name FROM orgs ORDER BY id').all().map((x) => x.id);
    assert.deepEqual(orgsAfter, orgsBefore, '恢复后 orgs 行集应与备份前一致');
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
    for (const must of ['audit_logs', 'events', 'usage_records', 'capability_bindings', 'schema_migrations']) {
      assert.ok(tables.includes(must), '关键表必须在：' + must);
    }
  } finally {
    check.close();
  }
  fs.rmSync(dest, { recursive: true, force: true });
});

await t('加密备份专项：无 key / 错 key / 签名篡改 / 一次性密钥的行为全部正确（P1-7）', async () => {
  const { createBackup, verifyBackup } = await import('../app/platform/operation/backup.mjs');

  // 通过 HTTP 建的备份都是统一密钥包
  const created = await call('POST', '/api/operation/backup', { token: adminToken });
  const good = path.join(tmp, 'backups', created.body.file);
  const allEntries = readZipEntries(fs.readFileSync(good));
  const byName = new Map(allEntries.map((e) => [e.name, e.data]));
  const manifest = JSON.parse(byName.get('manifest.json').toString('utf8'));
  assert.equal(manifest.formatVersion, 2);
  assert.ok(manifest.encryption && manifest.signature, '必须带加密块与签名');

  // ① 无 key：拒绝内容校验，明确提示需要密钥（不是假通过）
  const noKey = verifyBackup(good);
  assert.equal(noKey.ok, false);
  assert.equal(noKey.encrypted, true);
  assert.ok(noKey.problems.some((x) => x.includes('需要提供备份密钥')));

  // ② 错 key：kid 不匹配（早失败、信息明确）
  const wrongV = verifyBackup(good, { key: crypto.randomBytes(32).toString('hex') });
  assert.equal(wrongV.ok, false);
  assert.ok(wrongV.problems.some((x) => x.includes('kid')));

  // ③ 篡改 manifest 内容但保留旧签名 → 必须判签名不匹配
  const evilManifest = { ...manifest, db: { ...manifest.db, sha256: 'sha256:' + '0'.repeat(64) } };
  const evilEntries = allEntries.map((e) => (e.name === 'manifest.json'
    ? { name: e.name, data: Buffer.from(JSON.stringify(evilManifest)) }
    : { name: e.name, data: e.data }));
  const evilFile = path.join(tmp, 'backups', 'evil-signed.zip');
  fs.writeFileSync(evilFile, zipSync(evilEntries));
  const evilV = verifyBackup(evilFile, { key: BACKUP_KEY });
  assert.equal(evilV.ok, false);
  assert.ok(evilV.problems.some((x) => x.includes('签名不匹配')),
    '内容被改而签名未换，必须判签名失败：' + JSON.stringify(evilV.problems));

  // ④ 一次性密钥：不传 key 时包旁生成 .key，其内容能校验自己的包
  const oneShot = createBackup({ dataDir: tmp, label: 'oneshot' });
  assert.ok(oneShot.keyFile && fs.existsSync(oneShot.keyFile), '必须落盘 keyFile');
  const oneShotKey = fs.readFileSync(oneShot.keyFile, 'utf8').trim();
  const oneV = verifyBackup(oneShot.file, { key: oneShotKey });
  assert.equal(oneV.ok, true, '一次性密钥应能校验自己的包：' + JSON.stringify(oneV.problems));
  // 统一密钥不该能开一次性密钥的包
  assert.equal(verifyBackup(oneShot.file, { key: BACKUP_KEY }).ok, false);
});

await t('哈希链在本套件全部动作之后依然完整（治理没把自己写崩）', async () => {
  const v = audit.verifyChain(orgId);
  assert.equal(v.ok, true, 'checked=' + v.checked + ' total=' + v.total
    + (v.brokenAt ? ' brokenAt=' + JSON.stringify(v.brokenAt) : ''));
  assert.ok(v.checked >= 15, '本套件应已产生足够多的链上记录，实际 ' + v.checked);
});

/* ── 9. 多租户隔离（M5）：跨租户不可见 + per-tenant 契约层判定 ───── */

section('多租户隔离：跨租户不可见 + per-tenant 契约层判定');

let org2Slug = null;
let org2Id = null;
let admin2Token = null;

await t('建第二组织与 owner，登录拿 token（双租户世界的另一半）', async () => {
  const orgs = await import('../app/platform/identity/repos/orgs.mjs');
  const org2 = orgs.createOrg({ name: '隔离组织B', slug: 'iso-b-' + Date.now() });
  org2Id = org2.id;
  org2Slug = org2.slug;
  const roles = await import('../app/platform/identity/repos/roles.mjs');
  roles.ensureBuiltinRoles(org2Id);   // 初始化向导之外建组织必须补种内置角色
  // owner 是初始化向导专属（防绕过），第二个组织用 admin 角色
  await identity.createUser({ orgId: org2Id, username: 'admin-b', password: 'Adm1n-Pass!23', displayName: 'B管理员', roleKeys: ['admin'] });
  const login = await call('POST', '/api/identity/login', { json: { username: 'admin-b', password: 'Adm1n-Pass!23', orgSlug: org2Slug } });
  assert.equal(login.status, 200, login.text.slice(0, 200));
  admin2Token = login.body.token;
  assert.ok(admin2Token);
});

await t('跨租户资源不可见：审计、会话工具执行、产物、绑定清单各管各的', async () => {
  // org1 有一堆审计行；org2 查到的每行都必须是自己的
  const a2 = await call('GET', '/api/governance/audit?limit=500', { token: admin2Token });
  assert.equal(a2.status, 200);
  assert.ok(a2.body.items.length >= 1, 'org2 至少有自己的登录审计');
  assert.ok(a2.body.items.every((x) => x.tenant_id === org2Id),
    'org2 的审计不得混入 org1 的行：' + JSON.stringify(a2.body.items.map((x) => x.tenant_id)));

  // org1 的会话，org2 去执行工具 → 404（不泄漏存在性，不给 403）
  const x2 = await call('POST', '/api/kernel/sessions/' + sessionId + '/tools/stub.echo',
    { token: admin2Token, json: { args: { text: '跨租户越权' } } });
  assert.equal(x2.status, 404, '跨租户会话应 404，实际 ' + x2.status + ' ' + JSON.stringify(x2.body).slice(0, 120));

  // org1 的产物清单，org2 查 → 404
  const art2 = await call('GET', '/api/governance/artifacts?sessionId=' + sessionId, { token: admin2Token });
  assert.equal(art2.status, 404, '跨租户产物查询应 404，实际 ' + art2.status);

  // org2 的绑定清单不得含 org1 的行
  const b2 = await call('GET', '/api/capability/policies', { token: admin2Token });
  assert.equal(b2.status, 200);
  assert.ok((b2.body.bindings || []).every((x) => x.tenantId === org2Id || x.tenant_id === org2Id),
    'org2 的绑定清单不得含 org1 的行');
});

await t('per-tenant 契约层判定：org2 deny 不殃及 org1（listMcpServers 两档语义）', async () => {
  // ⚠️ 0.21.10：原来钉在 listTools 上。工具清单不存在了，但"保守并集 / per-tenant 精确"这对
  //    语义是**闸门自己的**，跟被治理的是哪种能力无关 —— 所以搬到一个仍然存在的概念上继续钉，
  //    而不是把这条用例删掉（删了就等于放弃了跨租户泄漏这道防线）。
  const mk = await call('POST', '/api/capability/mcp',
    { token: admin2Token, json: { name: 'tenant-demo', transport: 'http', config: { url: 'http://127.0.0.1:9' } } });
  assert.equal(mk.status, 200, JSON.stringify(mk.body).slice(0, 150));

  const set = await call('POST', '/api/capability/bindings',
    { token: admin2Token, json: { subjectType: 'tenant', capabilityType: 'server', capabilityId: 'tenant-demo', allow: 0 } });
  assert.equal(set.status, 200, JSON.stringify(set.body).slice(0, 150));

  // 不带租户 → 保守并集：org2 的 deny 生效，tenant-demo 从契约层消失
  const union = await kernel.provider.listMcpServers();
  assert.ok(!union.servers.some((x) => x.name === 'tenant-demo'), '保守并集：任一租户 deny 即从无租户清单消失');
  assert.equal(union.gatedBy, 'capability');

  // 带租户 → 精确：org1 可见、org2 不可见
  const forOrg1 = await kernel.provider.listMcpServers({ tenantId: orgId });
  assert.equal(forOrg1.gatedBy, 'capability:tenant');
  assert.ok(forOrg1.servers.some((x) => x.name === 'tenant-demo'), 'org1 没 deny，per-tenant 视角应可见');
  const forOrg2 = await kernel.provider.listMcpServers({ tenantId: org2Id });
  assert.ok(!forOrg2.servers.some((x) => x.name === 'tenant-demo'), 'org2 自己 deny，per-tenant 视角不可见');

  // 清理：org2 解除 deny → 无租户清单恢复
  const listed = await call('GET', '/api/capability/policies', { token: admin2Token });
  // listBindings 返回原始行（snake_case）
  const deny = (listed.body.bindings || []).find((x) => x.allow === 0 && x.capability_id === 'tenant-demo');
  assert.ok(deny, 'org2 应有一条 tenant-demo 的 deny 绑定');
  const del = await call('DELETE', '/api/capability/bindings/' + deny.id, { token: admin2Token });
  assert.equal(del.status, 200);
  const restored = await kernel.provider.listMcpServers();
  assert.ok(restored.servers.some((x) => x.name === 'tenant-demo'), '解除 deny 后恢复可见');

  await call('DELETE', '/api/capability/mcp/tenant-demo', { token: admin2Token });
});

await t('静态隔离扫描：0 违规（进程内调 scan()，防止它退化成摆设）', async () => {
  const iso = await import('./audit-tenant-isolation.mjs');
  const r = iso.scan();
  assert.ok(r.statementsChecked >= 50, '应扫到足量 SQL 语句，实际 ' + r.statementsChecked);
  assert.equal(r.violations.length, 0,
    '静态扫描必须 0 违规：' + JSON.stringify(r.violations, null, 2).slice(0, 600));
});

/* ── P1-8：主密钥轮换与后台重加密 ─────────────────────────────────── */

section('主密钥轮换：历史 v1 / 旧密钥 v2 / 未知密钥三类密文的重加密');

await t('后台重加密：老密文归位为当前 kid、明文不变；解不开的保持原样并计入 failures', async () => {
  const oldKey = crypto.randomBytes(32);
  const lostKey = crypto.randomBytes(32);
  const now = new Date().toISOString();
  const NAMES = ['rotate-legacy', 'rotate-foreign', 'rotate-lost'];

  const insert = (id, cipher) => db.run(
    'INSERT INTO credentials (id, org_id, name, cipher, updated_at) VALUES (?,?,?,?,?)',
    [id, orgId, id, cipher, now]);

  // ① 历史 v1 密文（裸 base64，oldKey 加密）—— 模拟评审之前的落库数据
  const v1plain = 'legacy-v1-secret';
  const iv = crypto.randomBytes(12);
  const cc = crypto.createCipheriv('aes-256-gcm', oldKey, iv);
  const ct1 = Buffer.concat([cc.update(Buffer.from(v1plain, 'utf8')), cc.final()]);
  insert('rotate-legacy', Buffer.concat([iv, cc.getAuthTag(), ct1]).toString('base64'));

  // ② v2 信封但 kid 属于旧密钥
  const v2plain = 'old-kid-v2-secret';
  insert('rotate-foreign', encryptSecret(v2plain, oldKey));

  // ③ 环里不会提供的密钥 → 注定解不开
  insert('rotate-lost', encryptSecret('lost-secret', lostKey));
  const lostBefore = db.get('SELECT cipher FROM credentials WHERE name=?', ['rotate-lost']).cipher;

  const ring = createSecretKeyring({ active: masterSecret, older: [oldKey] });
  const r = reencryptSecrets({ keyring: ring, decryptSecret, encryptSecret, cipherKid });

  assert.equal(r.scanned >= 3, true);
  assert.equal(r.legacyRewrapped, 1, '历史 v1 应重加密 1 项');
  assert.equal(r.foreignRewrapped, 1, '旧 kid 的 v2 应重加密 1 项');
  assert.equal(r.rewrapped, 2);
  assert.equal(r.failures.length, 1, '解不开的要如实计数');
  assert.equal(r.failures[0].table, 'credentials');
  assert.equal(r.failures[0].name, 'rotate-lost');

  // 落库校验：两行归位为当前 kid，明文不变
  const rows = db.all('SELECT name, cipher FROM credentials WHERE name IN (?,?,?)', NAMES);
  const byName = Object.fromEntries(rows.map((x) => [x.name, x.cipher]));
  for (const n of ['rotate-legacy', 'rotate-foreign']) {
    assert.ok(byName[n].startsWith('SE1.'), n + ' 必须变成 v2 信封');
    assert.deepEqual(cipherKid(byName[n]), ring.activeKid, n + ' 的 kid 必须归位');
  }
  assert.equal(decryptSecret(byName['rotate-legacy'], ring), v1plain);
  assert.equal(decryptSecret(byName['rotate-foreign'], ring), v2plain);

  // 解不开的行保持原样（不丢数据）
  assert.equal(byName['rotate-lost'], lostBefore);

  // 再跑一轮：幂等，零写入
  const r2 = reencryptSecrets({ keyring: ring, decryptSecret, encryptSecret, cipherKid });
  assert.equal(r2.rewrapped, 0, '已归位后重复执行不应有写入');
  assert.equal(r2.failures.length, 1, '解不开的仍然如实报告');

  // 清理
  db.run('DELETE FROM credentials WHERE name IN (?,?,?)', NAMES);
});

/* ── 收尾 ────────────────────────────────────────────────────────── */

await new Promise((r) => server.close(r));
try { await knowledge.close(); } catch { /* ignore */ }
try { db.closeDb(); } catch { /* ignore */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('');
console.log('='.repeat(64));
if (skips.length) {
  console.log('跳过 ' + skips + ' 条（单独计数，不计入通过）：');
  for (const s of skipped) console.log('  ~ ' + s.name + ' —— ' + s.reason);
}
console.log('用例 ' + total + ' 个｜失败 ' + fails + ' 个' + (skips.length ? '｜跳过 ' + skips + ' 个' : ''));
console.log('DONE fails=' + fails);
process.exit(fails ? 1 : 0);
