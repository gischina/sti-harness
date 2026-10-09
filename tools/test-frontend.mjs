/**
 * 前端行为回归 —— **真的执行 public/app/ 下的全部分片**，不是静态扫描。
 *
 * 背景（为什么必须有这个脚本）：
 *   M1 的前端只用 curl 验过接口，**从没在浏览器里跑过**。于是 `loadAll()` 里
 *   写着裸的 `loadStatus()`（那些函数只定义在 App 对象上），一登录就抛
 *   `ReferenceError: loadStatus is not defined` —— 接口全绿，页面全错。
 *   静态检查抓不到这类错误，只有把 JS 真跑一遍才行。
 *
 * 做法分两段：
 *   ① **录真实响应**：起一个真实服务（临时数据目录 + 测试替身 + listen(0)），
 *      走完真实流程（初始化 → 登录 → 建库 → 导入 markdown → 导入一个注定失败的
 *      .pdf → 检索），把每个接口的**真实响应体**录下来。
 *      **不手写桩数据** —— 手写的桩会跟真实形状漂移，测出来的"通过"就不值钱。
 *   ② **回放驱动前端**：用 `node:vm` + 极小 DOM 垫片，**按 index.html 的顺序逐片执行**
 *      （见 runApp 顶部的说明：拼成一个大脚本会让第二片起静默脱离严格模式），
 *      假 fetch 按路由返回 ① 录到的真实响应，然后驱动一遍真实用户路径。
 *      ⚠️ 分片清单**从 index.html 现读**，不写死 —— 漏挂一片会在这里露出来。
 *
 * 诚实边界：
 *   · **这不是浏览器**。它验证"逻辑能不能跑通、有没有引用错名字"，不验证 CSS 布局。
 *   · 垫片不支持的 API 返回 null（前端里普遍写成 `($('#x') || {}).value`，是允许的），
 *     不会静默伪造出一个"能用"的元素 —— 未渲染的控件就是取不到，这点与浏览器一致。
 *   · `needsSetup`、未登录、权限矩阵这三种"输入"按用例改写，**形状取自真实响应**，
 *     因为一次录制只能落在一个状态上。
 *   · 前端抛出的未捕获 rejection 会被收集起来断言为空 —— 这正是当年那个 bug 的形态。
 *
 * 用法：node tools/test-frontend.mjs   → 末行 `DONE fails=0`
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// 两步验证（TOTP）纯函数：录制 MFA 流程时要自己算出**当前有效**的动态码
// （与 test-http 同一套算法同一套护栏 —— 步号超窗就报红提示重跑）。
import { base32Decode, hotp, totpStepAt, TOTP_WINDOW } from '../app/platform/identity/totp.mjs';
// ZIP 打包（录制"Skill 卸载"用例时要在服务端现造一个合法 zip 包当安装素材）。
import { zipSync } from '../app/util/zip.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

/**
 * 读 `public/style.css`（原样，含注释）。
 *
 * ⚠️ 定义**必须**放在文件靠前处：下面的用例是**顺序执行的顶层 await**，
 *    任何在用例之后声明的 `const` 都会在更早的用例里撞上 TDZ
 *    （`Cannot access 'WB_CSS' before initialization`）。
 *    它原来是挂在文件中间某个用例旁边的 —— 一旦有更早的用例要用它就会炸，
 *    而炸的位置在"更早的那个用例"，很容易归因错。
 *
 * ⚠️ 返回的是**原文**：要不要剥注释由调用方决定。做样式断言时通常该剥
 *    （否则断言会命中注释里的示例文字 —— 本项目栽过一次：断言被一句注释喂绿了）。
 */
const WB_CSS = () => fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

// P1-7：备份自 v2 起为独立密钥加密，录制/回放必须用同一固定密钥，
// 否则录到的 verify 响应是 verdict.ok=false（加密包无密钥），回放必然失败。
const BACKUP_KEY = crypto.randomBytes(32).toString('hex');

/**
 * 前端自 0.11.2 起按域拆成 `public/app/*.js` 多片，由 index.html **顺序**加载。
 *
 * ⚠️ 这里**不写死文件名**：直接解析 index.html 里的 `<script src="./app/…">`。
 *    这样"回归跑的就是页面真的会加载的那串文件、且顺序一致"——新增一片却忘了挂进
 *    index.html（或挂错顺序）会在这里就露出来，而不是等用户白屏。
 */
const APP_FILES = (() => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  return [...html.matchAll(/<script[^>]*\bsrc=["']\.\/app\/([^"']+)["']/g)].map((m) => m[1]);
})();
const APP_PATHS = APP_FILES.map((f) => path.join(PUBLIC_DIR, 'app', f));

/** 按加载顺序读全部前端分片（返回 [文件名, 源码] 列表） */
function readAppParts() {
  return APP_FILES.map((f, i) => [f, fs.readFileSync(APP_PATHS[i], 'utf8')]);
}

/** 全部前端分片拼起来的源码 —— **仅用于静态扫描**；执行时必须分片跑（见 runApp）。 */
function readAppSource() {
  return APP_FILES.map((f, i) => fs.readFileSync(APP_PATHS[i], 'utf8')).join('\n');
}

let total = 0;
let fails = 0;
const failures = [];

async function t(name, fn) {
  total++;
  try {
    await fn();
    console.log('  \u2713 ' + name);
  } catch (e) {
    fails++;
    failures.push({ name, error: e });
    console.log('  \u2717 ' + name);
    for (const line of String((e && e.message) || e).split('\n').slice(0, 10)) console.log('      ' + line);
  }
}

function section(title) {
  console.log('');
  console.log('── ' + title + ' ' + '─'.repeat(Math.max(0, 56 - title.length)));
}

/* ══════════════════════════════════════════════════════════════════
   ① 起真实服务，录真实响应
   ══════════════════════════════════════════════════════════════════ */

const routes = Object.create(null);   // 'METHOD /path' → { status, body }
const recorded = [];                  // 录制流水，便于失败时定位

async function bootRealServer() {
  // ⚠️ 必须在 import 任何 app 模块之前设置：paths.mjs 在**模块加载时**解析 DATA_DIR。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-fe-'));
  process.env.STI_DATA_DIR = path.join(tmp, 'data');
// 内核改由下面**显式注入测试替身**（0.21.4 起没有"内核模式"这个开关了）。
  process.env.STI_EMBED_PROVIDER = '';      // 强制纯文本模式（不依赖本机有没有向量服务）
  process.env.STI_WORKERS = '1';
  process.env.STI_RATE_LIMIT = '100000';        // 别让限流把录制阶段自己挡了
  process.env.STI_RATE_LIMIT_LOGIN = '100000';  // 登录路由有独立阈值，录制会反复登录

  await import('../app/util/quiet-warnings.mjs');   // 收敛 node:sqlite 的实验性警告
  const db = await import('../app/data/db.mjs');
  const { migrate } = await import('../app/data/migrate.mjs');
  const { ensureRuntimeDirs, DATA_DIR, ARCHIVE_DIR, ANCHOR_DIR } = await import('../app/paths.mjs');
  const { loadConfig } = await import('../app/config.mjs');
  const { createKernel } = await import('../app/kernel/index.mjs');
const { createKernelStub } = await import('./kernel-stub.mjs');
  const { createIdentityService } = await import('../app/platform/identity/service.mjs');
  const { createKnowledgeService } = await import('../app/platform/knowledge/service.mjs');
  const { createGovernanceService } = await import('../app/platform/governance/service.mjs');
  const { createOperationService } = await import('../app/platform/operation/service.mjs');
  const { createModelService } = await import('../app/platform/model/service.mjs');
  const { createScheduleService } = await import('../app/platform/schedule/service.mjs');
  const { createNotifyService } = await import('../app/platform/notify/service.mjs');
  const { encryptSecret, decryptSecret } = await import('../app/platform/identity/credentials.mjs');
  const audit = await import('../app/platform/governance/audit.mjs');
  const { createServer } = await import('../app/http/server.mjs');

  ensureRuntimeDirs();
  db.openDb();
  migrate();

  const config = loadConfig();
  // 显式注入测试替身：产品路径上没有"没配地址也能用"的内核（那层降级已删）。
const kernel = createKernel({ provider: createKernelStub(), reason: '回归用测试替身（不依赖真实内核）' });
  // 主密钥必须是 32 字节 **Buffer**（与生产 `data/.secret` 的形状一致）。此前这里是
  // hex 字符串：在 HMAC 路径上碰巧能用，但一步 TOTP 密钥加密就会撞上 needKey 的
  // "应为 32 字节"—— 录制直接 500，回放数据一条也录不到。
  const identity = createIdentityService({ masterSecret: crypto.randomBytes(32) });
  // ⚠️ 知识服务也必须与 `app/main.mjs` **同构**装配（与下面 notify/schedule 同一条理由）：
  // 少了 `identity` / `resolveScopedRoles`，4.6 的库级 ACL 就静默退化成"只看全局角色"——
  // 录制期表现为"库级授权接口直接报未装配"，回放期则是所有受限库对所有人可见。
  // 这属于**测试脚手架与生产装配漂移**，录出来的响应不能代表真实行为。
  const knowledge = createKnowledgeService({
    config, audit, resolveCredential: () => null,
    identity,
    resolveScopedRoles: (userId, scopeType) => identity.scopedRolesForUser(userId, scopeType),
  });
  const operation = createOperationService({ dataDir: DATA_DIR, backupKey: BACKUP_KEY });
  const model = createModelService({});
  // 与 main.mjs 同构：成本核算要"按租户取模型条目"，靠装配层注入。
  const governance = createGovernanceService({ resolveProviders: (tid) => model.listProviders(tid) });
  // P1-2：调度与通知服务必须与 `app/main.mjs` **同构**装配，否则录到的响应没有意义 ——
  // 少了 masterSecret 就会录到"拒绝以明文落库"，少了 operation/governance，
  // 任务体就会全部记成"依赖未装配"。录一个必然失败的桩，测出来的"通过"不值钱。
  const masterSecret = crypto.randomBytes(32);        // AES-256：32 字节，不是 hex 字符串
  const notify = createNotifyService({
    masterSecret, encryptSecret, decryptSecret,
    resolveCredential: () => null,
    // 与 test-http 同理由：本套回归要真的往 127.0.0.1 上的桩服务器投递一次（录"试发成功"），
    // 而生产默认禁止回环出站。
    allowLoopback: true,
  });
  const schedule = createScheduleService({
    governance, operation, model, notify,
    archiveDir: ARCHIVE_DIR, anchorDir: ANCHOR_DIR,
  });
  // 0.21.0 工作区服务：与 main.mjs 同构装配（与 knowledge/notify 同一条纪律 ——
  // 少了它，工作区路由在装配期直接报错，录制一条响应都拿不到）。
  const { createWorkspaceService } = await import('../app/platform/workspace/service.mjs');
  const workspace = createWorkspaceService({ identity, audit });

  const { server } = createServer({
    config, kernel, identity, knowledge, workspace, governance, operation, model, notify, schedule,
    paths: { DATA_DIR }, startedAt: Date.now(),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  return {
    base, tmp, server, knowledge, db,
    async close() {
      await new Promise((r) => server.close(r));
      await knowledge.close();        // 必须先停 worker 池，否则进程挂住不退出
      db.closeDb();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function makeRecorder(base) {
  return async function rec(method, pathname, opts = {}) {
    const headers = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;
    const res = await fetch(base + pathname, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    // 一律按字节读：`res.text()` 会把 ZIP 解成 UTF-8 替换字符（U+FFFD），
    // 回放时前端再包一层 Blob 也还原不回真字节。二进制响应传 `saveRaw`，另存原始 base64。
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let body = null;
    try { body = JSON.parse(text); } catch { body = { _nonJson: text.slice(0, 400) }; }
    // ⚠️ 回放时的键是 `METHOD /path`（假 fetch 会去掉 query），所以录制也必须去掉 query。
    //   早先这里把 `?limit=200` 一起当键，于是前端请求 `/documents?limit=200` 在回放里
    //   永远 404 —— 页面看起来"渲染了"，其实是空态，测试反而查不出真问题。
    const key = method + ' ' + pathname.split('?')[0];
    const target = opts.saveAs || key;
    routes[target] = { status: res.status, body };
    if (opts.saveRaw) routes[target]._b64 = buf.toString('base64');
    recorded.push(target + ' → ' + res.status);
    return { status: res.status, body };
  };
}

const svc = await bootRealServer();
const rec = makeRecorder(svc.base);

console.log('');
console.log('STI HARNESS 前端行为回归（真实服务录制 + vm 执行 app.js）');
console.log('='.repeat(64));

section('录制：起真实服务并走完真实流程');

let KB_ID = '';
let DOC_ID = '';
let KB_GRANT_ID = '';        // 录到的库级授权绑定 id（撤销用例要用同一个）
let KB_GRANTEE = '';         // 被授权主体的显示名（断言名单渲染要看到它）
let SESSION_ID_FOR_LOG = ''; // 会话日志用例要下载的那个会话 id（从补录的会话清单里取）
let E3_DEL_NAME = '';        // 录制期被删掉的备份文件名（E3 回放里"点名的删除按钮"就落在它身上）
let loginBody = null;
let meBody = null;
let meAnonStatus = 0;
let meAnonBody = null;

const ORG = { name: '某某公司测试组织', username: 'admin', password: 'Fat-test-9x7Q' };

await t('全新机器：初始化状态如实报告 needsSetup=true', async () => {
  const r = await rec('GET', '/api/identity/setup', { saveAs: 'GET /api/identity/setup#fresh' });
  assert.equal(r.status, 200);
  assert.equal(r.body.setup.needsSetup, true, '临时数据目录应是全新机器');
});

await t('未登录时 /api/identity/me 真的是 401（不是靠桩假装）', async () => {
  const r = await rec('GET', '/api/identity/me');
  meAnonStatus = r.status;
  meAnonBody = r.body;
  assert.equal(r.status, 401, '未登录访问 me 必须是 401，实际 ' + r.status);
});

await t('初始化向导：建组织 + 管理员成功', async () => {
  const r = await rec('POST', '/api/identity/setup', {
    body: {
      orgName: ORG.name,
      adminUsername: ORG.username,
      adminPassword: ORG.password,
      adminDisplayName: '平台管理员',
      credential: null,
    },
  });
  assert.ok(r.status === 201 || r.status === 200, '初始化应成功，实际 ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
  assert.ok(r.body.org && r.body.org.id, '应返回组织');
});

await t('初始化后再读状态：needsSetup=false（这是登录页要用的那一份）', async () => {
  const r = await rec('GET', '/api/identity/setup', { saveAs: 'GET /api/identity/setup#ready' });
  assert.equal(r.body.setup.needsSetup, false);
});

await t('登录：拿到令牌，并且 /api/identity/me 返回真实权限矩阵', async () => {
  const l = await rec('POST', '/api/identity/login', {
    body: { username: ORG.username, password: ORG.password },
  });
  assert.equal(l.status, 200, '登录应成功：' + JSON.stringify(l.body).slice(0, 200));
  assert.ok(l.body.token, '应下发令牌');
  // 令牌是本次临时库的产物，回放时不需要它：只保留形状，值换成占位符
  loginBody = { ...l.body, token: '<recorded-token>', sessionId: '<recorded-session>' };

  const m = await rec('GET', '/api/identity/me', { token: l.body.token });
  assert.equal(m.status, 200);
  assert.ok(m.body.user && m.body.user.id, 'me 应返回用户');
  assert.ok(m.body.permissions && m.body.permissions.knowledge, 'me 应返回权限矩阵');
  meBody = m.body;
});

await t('登录后拉取全部页面数据（loadAll 要打的 8 个接口都真实可用）', async () => {
  const token = (await (async () => {
    const l = await rec('POST', '/api/identity/login', { body: { username: ORG.username, password: ORG.password } });
    return l.body.token;
  })());

  const paths = [
    'GET /api/system/status',
    'GET /api/system/routes',
    'GET /api/system/contract',
    'GET /api/system/middleware',
  ];
  for (const k of paths) {
    const [m, p] = k.split(' ');
    const r = await rec(m, p, { token });
    assert.equal(r.status, 200, k + ' 应 200，实际 ' + r.status);
  }
  for (const [m, p] of [
    ['GET', '/api/kernel/sessions?limit=50'],
    ['GET', '/api/identity/users?limit=200'],
    ['GET', '/api/identity/roles'],
    ['GET', '/api/identity/credentials'],
    ['GET', '/api/identity/apikeys'],
    ['GET', '/api/knowledge/status'],
    ['GET', '/api/knowledge/bases'],
    // B8：部门列表也要录（账号页的部门面板依赖它；缺了它会静默渲染成"还没有部门"，
    // 而那与"接口坏了"在前端看起来一模一样）
    ['GET', '/api/identity/departments'],
    // 0.16.0：平台设置页也是 loadAll 的一部分 —— 缺了它逐路由扫荡会把
    // "回放数据齐全却卡在加载态"误报成红
    ['GET', '/api/system/settings'],
    // 0.17.0：两步验证状态同样是 loadAll 的一部分（「我的账号」面板与账号页
    // 的「两步」徽标都读它）—— 缺了它页面会渲染成"读不到两步验证状态"。
    // 这份录制是 admin 自己的状态（未开启）；MFA 各形态由本节后面的用例覆盖。
    ['GET', '/api/identity/totp'],
  ]) {
    const r = await rec(m, p, { token });
    assert.equal(r.status, 200, m + ' ' + p + ' 应 200，实际 ' + r.status);
  }
  // 关键：这些响应里的字段必须够页面渲染，缺字段会立刻在下一步炸出来
  const st = routes['GET /api/system/status'].body;
  assert.ok(st.platform && st.platform.node && st.platform.node.current, 'status.platform.node.current 必须存在');
  assert.ok(st.kernel && st.kernel.ready === true, 'status.kernel.ready 必须存在且为真（回归注入了测试替身）');
  assert.ok(st.database && typeof st.database.tables === 'number', 'status.database.tables 必须是数字');
  assert.ok(st.migrations && 'upToDate' in st.migrations, 'status.migrations.upToDate 必须存在');
  globalThis.__token = token;
});

const MD_SAMPLE = [
  '# 权限管理规范',
  '',
  '本规范描述平台的权限模型。权限判定由纯函数实现，未知角色一律拒绝。',
  '',
  '## 检索',
  '',
  '知识库检索按组织隔离。中文检索使用重叠双字串预处理，避免整段汉字被当成一个词。',
  '',
].join('\n');

await t('建知识库；先按 .md 文件导入一次（显式格式线索路径）', async () => {
  const token = globalThis.__token;
  const b = await rec('POST', '/api/knowledge/bases', { token, body: { name: '企业制度库' } });
  assert.equal(b.status, 201, '建库应 201：' + JSON.stringify(b.body).slice(0, 200));
  KB_ID = b.body.base.id;

  const d = await rec('POST', '/api/knowledge/documents', {
    token,
    saveAs: 'POST /api/knowledge/documents#md-file',
    body: { kbId: KB_ID, text: MD_SAMPLE, title: '权限管理规范（文件版）', filename: '权限管理规范.md', mime: 'text/markdown' },
  });
  assert.equal(d.status, 201, '导入应 201：' + JSON.stringify(d.body).slice(0, 300));
  assert.equal(d.body.document.status, 'ready', 'markdown 应解析成功');
  assert.equal(d.body.report.parser, 'markdown', '.md 应走 markdown 解析器，实际 ' + d.body.report.parser);
});

await t('模拟前端"粘贴文本"导入（.txt 文件名 + Markdown 内容）：必须识别为 Markdown', async () => {
  const token = globalThis.__token;
  // 严格照前端 importText 的请求形状：filename = 标题 + '.txt'，没有 mime。
  // 这一条是**回放时前端真正会拿到的那一份**，所以必须写成正式键。
  const d = await rec('POST', '/api/knowledge/documents', {
    token,
    body: { kbId: KB_ID, text: MD_SAMPLE, title: '权限管理规范', filename: '权限管理规范.txt' },
  });
  assert.equal(d.status, 201, '导入应 201：' + JSON.stringify(d.body).slice(0, 300));
  assert.equal(d.body.document.status, 'ready', '应解析成功');
  assert.equal(d.body.report.parser, 'markdown',
    '.txt 但内容是 Markdown：应被识别为 markdown，实际 ' + d.body.report.parser
    + '（识别不出来 → # 会留在正文里、标题层级丢失、引用不可定位）');
  assert.ok((d.body.report.warnings || []).some((w) => /识别为 Markdown/.test(w)),
    '自动判定必须写进 warnings，可审计。实际 warnings=' + JSON.stringify(d.body.report.warnings));
  DOC_ID = d.body.document.id;
});

await t('导入一个 .pdf：本机缺外部命令时必须失败并写明原始原因', async () => {
  const token = globalThis.__token;
  const bad = await rec('POST', '/api/knowledge/documents', {
    token,
    // 这条不能覆盖上面那条成功导入的响应：前端"导入文本"用的正是 POST /api/knowledge/documents。
    // 早先两条都写同一个键，结果回放时成功路径拿到的是"解析失败"，测试假红。
    saveAs: 'POST /api/knowledge/documents#pdf',
    body: {
      kbId: KB_ID,
      filename: '年度报告.pdf',
      mime: 'application/pdf',
      contentBase64: Buffer.from('%PDF-1.4 fake body, not a real pdf').toString('base64'),
    },
  });
  // 两种都算"诚实"：本机没有 pdftotext → 422 且 failed 带原始原因；
  // 装了 pdftotext → 也可能因为不是真 PDF 而 failed。无论哪种都必须 failed + 有 error 文本。
  assert.ok(bad.status === 422 || bad.status === 201, '导入 pdf 的返回码异常：' + bad.status);
  const doc = bad.body.document;
  assert.ok(doc, '响应里必须带 document 记录（前端要展示它）');
  assert.equal(doc.status, 'failed', '这个 pdf 必须进 failed，不能假装可检索');
  assert.ok(doc.error && doc.error.length > 4, 'failed 必须带原始错误原因，实际：' + JSON.stringify(doc.error));
  assert.ok(!/解析失败$/.test(doc.error), '错误原因不能是一句空话："' + doc.error + '"');
});

/* ── 库级授权（§B9）：录一条**真实**授权，让「库级授权」面板有真名单可渲染 ──
 * 为什么必须录真实数据：手写的桩会跟真实形状漂移（字段名、subjectName 的回填、
 * roleKey 的取值），测出来的"通过"就不值钱。
 * 这里**刻意不新建用户** —— 别的用例依赖 `users[0]` 是 owner，建新用户会把索引挪位。
 * 因此样本是"把 owner 授进本库"。测的是**名单能列出、能撤销、参数送到了哪**；
 * 至于"授权真的改变了谁的可见性"，由 test-core / test-governance 的库级 ACL 回归钉住。 */

await t('录制库级授权：把 owner 授进知识库 + 录下名单 + 录下撤销（§B9 面板的真实数据源）', async () => {
  const token = globalThis.__token;
  const users = (await rec('GET', '/api/identity/users?limit=200', { token })).body.users;
  const grantee = users[0];
  assert.ok(grantee && grantee.id, '需要一个可授权的主体');

  const g = await rec('POST', '/api/knowledge/bases/' + KB_ID + '/grants', {
    token,
    saveAs: 'POST /api/knowledge/bases/' + KB_ID + '/grants',
    body: { subjectType: 'user', subjectId: grantee.id, roleKey: 'viewer' },
  });
  assert.equal(g.status, 201, '库级授权应 201：' + JSON.stringify(g.body).slice(0, 300));
  assert.ok(g.body.grant && g.body.grant.id, '授权响应必须带回绑定 id（撤销要用它）');
  KB_GRANT_ID = g.body.grant.id;

  // 名单（App.loadBaseGrants 的调用路径）
  const l = await rec('GET', '/api/knowledge/bases/' + KB_ID + '/grants', { token });
  assert.equal(l.status, 200);
  assert.equal(l.body.grants.length, 1, '名单应恰好 1 条，实际 ' + JSON.stringify(l.body.grants));
  assert.equal(l.body.grants[0].subjectType, 'user');
  assert.equal(l.body.grants[0].subjectName, grantee.username,
    'subjectName 必须回填用户名 —— 否则页面只能显示一串内部 id');
  assert.equal(l.body.grants[0].roleKey, 'viewer', 'roleKey 要能回显');
  KB_GRANTEE = l.body.grants[0].subjectName;

  // 撤销（App.revokeGrant 的调用路径）。**录在名单之后**：回放时"撤销后重新拉名单"
  // 仍拿到上面那份"有 1 条"的快照 —— 与用户组删除用例同一个取舍（回放不重建状态）。
  const del = await rec('DELETE', '/api/knowledge/bases/' + KB_ID + '/grants/' + KB_GRANT_ID, {
    token, saveAs: 'DELETE /api/knowledge/bases/' + KB_ID + '/grants/' + KB_GRANT_ID,
  });
  assert.equal(del.status, 200, '撤销应 200：' + JSON.stringify(del.body).slice(0, 200));
});

await t('文档列表：状态统计里 ready 与 failed 同时存在（前端要显示两类）', async () => {
  const token = globalThis.__token;
  // 建库之后再录一次 bases：上面 loadAll 批次里录到的是"还没有任何库"的那一份，
  // 不重录的话前端知识库列表永远是空的 —— 而"空列表"本身也是个合法渲染结果，
  // 测试会因此看起来通过、实际什么都没验证。
  const b2 = await rec('GET', '/api/knowledge/bases', { token });
  assert.ok(b2.body.bases.length >= 1, '建库后应能读到至少一个知识库');

  const r = await rec('GET', '/api/knowledge/bases/' + KB_ID + '/documents?limit=200', { token });
  assert.equal(r.status, 200);
  assert.ok(r.body.statusCounts.ready >= 1, '应有 ready 文档');
  assert.ok(r.body.statusCounts.failed >= 1, '应有 failed 文档');
  assert.ok(r.body.items.length >= 2, '列表应含两条以上');
  const bad = r.body.items.find((x) => x.status === 'failed');
  assert.ok(bad && bad.error, '列表里失败文档必须带 error');
});

await t('分块预览接口可用，且每个分块带定位与引用标签', async () => {
  const token = globalThis.__token;
  const r = await rec('GET', '/api/knowledge/documents/' + DOC_ID + '/chunks?limit=50', { token });
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length >= 1, '应有分块');
  const it = r.body.items[0];
  assert.ok(it.citationLabel, '分块应带引用标签');
  assert.ok('locationKnown' in it, '分块必须带 locationKnown 标记');
});

await t('检索：中文 2 字词与 4 字词都能命中，并带完整引用链', async () => {
  const token = globalThis.__token;
  const r = await rec('POST', '/api/knowledge/search', {
    token, body: { query: '权限管理', limit: 10, kbIds: [KB_ID] },
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.results.length >= 1, '「权限管理」应有命中');
  assert.ok(r.body.retrieval && r.body.retrieval.mode, '检索响应必须说明当前模式');
  const c = r.body.results[0].citation;
  assert.ok(c && c.label, '结果必须带引用链');
  assert.ok(c.locationKnown === true, '这条分块应有定位信息');

  // 换序查询（真实的失败模式：bigram 用 AND 时会 0 命中）
  const r2 = await rec('POST', '/api/knowledge/search', {
    token,
    saveAs: 'POST /api/knowledge/search#reordered',
    body: { query: '管理权限', limit: 10, kbIds: [KB_ID] },
  });
  assert.ok(r2.body.results.length >= 1, '「管理权限」（换序）也应命中');

  // 状态快照放到最后重录一次：这时才反映"1 个库 / 2 个文档 / 若干个分块"的真实情况
  const st = await rec('GET', '/api/knowledge/status', { token });
  assert.ok(st.body.knowledge, '知识库状态应可用');
});

await t('空查询 / 不存在的库：错误语义真实可信（不是 200 假成功）', async () => {
  const token = globalThis.__token;
  // ⚠️ 空查询请求的路径与正式检索完全相同，**必须另存**：
  //   早先这里直接写正式键，于是回放时前端检索拿到的是这条 400（"查询内容不能为空"），
  //   页面看起来"跑了但没结果"，真实原因却是录制把正常响应覆盖掉了。
  const a = await rec('POST', '/api/knowledge/search', {
    token, saveAs: 'POST /api/knowledge/search#empty', body: { query: '', limit: 10 },
  });
  assert.equal(a.status, 400, '空查询应 400');
  const b = await rec('GET', '/api/knowledge/bases/does_not_exist/documents', { token });
  assert.equal(b.status, 404, '不存在的库应 404');
});

await t('录制 E2 素材：文档改名（PATCH）——只动显示字段，状态与分块不变', async () => {
  const token = globalThis.__token;
  // 标题带前后空格：录制即钉住服务端 trim 的口径（回放段断言的请求体也是 trim 后的）。
  // 路径带 DOC_ID，与任何正式键都不碰撞；此处的改名只影响本条之后的录制快照，
  // 而后续没有任何录制再读这份文档的标题（已核证），不会让既有回放漂移。
  const r = await rec('PATCH', '/api/knowledge/documents/' + DOC_ID, {
    token, body: { title: '  权限管理规范（改后）  ' },
  });
  assert.equal(r.status, 200, '改名应 200：' + JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.document.title, '权限管理规范（改后）', '服务端应 trim 后再存');
  assert.equal(r.body.document.status, 'ready', '改名不得触发重新解析（状态必须还是 ready）');
  assert.ok(r.body.document.chunkCount >= 1, '改名不得碰分块');
});

/* ── 治理与审计（M3）：录制真实治理数据，供前端两页回放 ───────────── */

await t('录制治理数据：建配额（审计里留下 quota 留痕）', async () => {
  const token = globalThis.__token;

  const q = await rec('POST', '/api/governance/quotas', {
    token, saveAs: 'POST /api/governance/quotas',
    body: { subjectType: 'tenant', metric: 'turns', period: 'day', limitValue: 5, mode: 'block' },
  });
  assert.equal(q.status, 201, '建配额应 201：' + JSON.stringify(q.body).slice(0, 200));
});

await t('录制治理两页要拉的全部接口（loadAll / loadAudit / loadQuotas）', async () => {
  const token = globalThis.__token;
  for (const [m, p] of [
    ['GET', '/api/governance/audit?limit=200'],
    ['GET', '/api/governance/quotas'],
    ['GET', '/api/governance/usage'],
  ]) {
    const r = await rec(m, p, { token });
    assert.equal(r.status, 200, m + ' ' + p + ' 应 200，实际 ' + r.status);
  }
  // 形状断言：缺字段页面就会在回放时炸出来
  const au = routes['GET /api/governance/audit'].body;
  assert.ok(Array.isArray(au.items) && au.items.length >= 5, '审计列表应有记录（装配期与治理动作都留痕了）');
  assert.ok(au.latestHash, '应有链尾哈希');

  // 校验接口也录一份（前端"重算并校验整条链"按钮要用）
  const v = await rec('POST', '/api/governance/audit/verify', { token, saveAs: 'POST /api/governance/audit/verify' });
  assert.equal(v.status, 200);
  assert.equal(v.body.verify.ok, true);
});

/* ── 能力分发（M4）：录制能力三页要拉的接口与动作 ──────────────────── */

await t('录制能力分发数据：能力三页接口 + 导出', async () => {
  const token = globalThis.__token;
  // Skill 卸载（0.18.0）的素材：先真装两个 Skill —— 一个 zip 来源（有安装目录可删）、
  // 一个 import 来源（只有登记行）—— 回放段「卸载」用例才有行可点、两种口径都有得验。
  // 必须先于下面清单 GET：录到的那份 skills 清单里要含它们。
  const zipB64 = zipSync([{ name: 'SKILL.md', data: Buffer.from('# rec smoke skill\n', 'utf8') }]).toString('base64');
  const ins = await rec('POST', '/api/capability/skills/install', {
    token, body: { name: 'rec-skill-zip', zipBase64: zipB64 },
  });
  assert.equal(ins.status, 200, '冒烟安装应成功：' + JSON.stringify(ins.body).slice(0, 200));
  assert.equal(ins.body.skill.source, 'zip');
  const smokeZipPath = ins.body.skill.path;
  assert.ok(smokeZipPath && fs.existsSync(smokeZipPath), 'zip 来源的安装目录应已落盘');
  const imp = await rec('POST', '/api/capability/import', {
    token, saveAs: 'POST /api/capability/import',
    body: { format: 'sti-harness/capabilities', skills: [{ name: 'rec-skill-import' }] },
  });
  assert.equal(imp.status, 200, '冒烟导入应成功：' + JSON.stringify(imp.body).slice(0, 200));
  assert.equal(imp.body.imported.skills.installed, 1);
  // 三页要拉的全部接口（loadCapability 的请求序列）
  for (const [m, p] of [
    ['GET', '/api/capability/skills'],
    ['GET', '/api/capability/mcp'],
    ['GET', '/api/capability/policies'],
  ]) {
    const r = await rec(m, p, { token });
    assert.equal(r.status, 200, m + ' ' + p + ' 应 200');
  }
  // 形状断言
  const sk = routes['GET /api/capability/skills'].body;
  assert.ok(Array.isArray(sk.registry) && Array.isArray(sk.kernel.skills), 'skills 响应要有 registry 与 kernel.skills 两个来源');
  assert.ok(typeof sk.kernel.source === 'string', '内核探测要如实标注来源');
  // 上面装的两个冒烟技能要出现在这份清单里 —— 回放页「卸载」用例就点它们
  for (const n of ['rec-skill-zip', 'rec-skill-import']) {
    assert.ok(sk.registry.some((x) => x.name === n), '清单应含冒烟技能 ' + n);
  }
  // ⚠️ 0.21.10：这里原来录三条「工具启停」响应（App.toggleTool 的调用路径 + 两条构造
  //    "内核没有但登记过"差距行的素材）。工具不再是可登记的能力 —— 没有清单、没有独立开关，
  //    由内核自己调用、只在会话事件流里以工具卡出现 —— 所以这三条录制**整段删除**，
  //    连同下面补录清单里的 registryTools 断言。前端也不再发这个请求，留一条录制只会变成死字节。
  // 补录 Skill 清单（覆盖录制期第一份；键去 query 后与前端调用一致）。
  // 为什么必须补：真正的素材是上面刚装的两个冒烟技能，第一份清单录在它们之前。
  const skList = await rec('GET', '/api/capability/skills', { token });
  assert.ok(skList.body.registry.some((s) => s.name === 'rec-skill-zip'),
    '补录的清单仍要含两个冒烟技能 —— 下面的卸载用例要靠它们');
  // 反向钉：工具段必须**彻底不在**，而不是变成空数组（前端无法分辨"空"与"没给"）
  assert.ok(!('registryTools' in skList.body), '清单里不应再有 registryTools');
  // MCP 登记（App.registerMcp 的调用路径）：登记一个本机命令型条目 ——
  // 之前清单一直是空的，回放页没有"已登记服务行"，行内"改配置"按钮测不到。
  // 不带 config：本夹具未配主密钥，config 要走 AES 加密落库（加密路径 test-http 已覆盖）
  const mc = await rec('POST', '/api/capability/mcp', {
    token, saveAs: 'POST /api/capability/mcp',
    body: { name: 'rec-stub-mcp', transport: 'stdio', enabled: true },
  });
  assert.equal(mc.status, 200, 'MCP 登记应成功：' + JSON.stringify(mc.body).slice(0, 200));
  assert.ok(mc.body.server && mc.body.server.name === 'rec-stub-mcp', '登记响应要带回条目');
  // 补录 MCP 清单（覆盖录制期第一份空响应；键去 query 后与前端调用一致）
  const mcpList = await rec('GET', '/api/capability/mcp', { token });
  assert.ok(mcpList.body.registry.some((x) => x.name === 'rec-stub-mcp'), '补录的清单要带刚登记的条目');
  // 绑定新增（App.setBinding 的调用路径；回放按 METHOD+path 键取响应，不看 body）
  // ⚠️ 0.21.10：原来绑的是 capabilityType:'tool' / 'stub.echo'。tool 层已删除，
  //    绑到这里会 400（而且**必须** 400，不能静默收下）—— 改绑仍然存在的 server 层，
  //    指向下面马上要登记的 rec-stub-mcp。
  const b = await rec('POST', '/api/capability/bindings', {
    token, saveAs: 'POST /api/capability/bindings',
    body: { subjectType: 'tenant', capabilityType: 'server', capabilityId: 'rec-stub-mcp', allow: 1 },
  });
  assert.equal(b.status, 200, '绑定新增应成功');
  assert.ok(b.body.binding && b.body.binding.id, '响应要带回最终生效的绑定行');
  // 补录可见性治理清单：绑定表的数据源是 policies 响应里的 bindings，
  // 录制期第一份是空的 —— 行内"切换判定"按钮依赖非空绑定
  const pol2 = await rec('GET', '/api/capability/policies', { token });
  assert.ok((pol2.body.bindings || []).length >= 1, '补录的 policies 要带上刚建的绑定');
  // 导出（App.exportCaps 的调用）
  const e = await rec('GET', '/api/capability/export', { token, saveAs: 'GET /api/capability/export' });
  assert.equal(e.status, 200);
  assert.equal(e.body.format, 'sti-harness/capabilities');
  // MCP 条目的 config 必须是 null（脱敏红线也钉在前端数据上）
  for (const m of e.body.mcp) assert.equal(m.config, null, '导出的 MCP config 必须是 null');
  // 卸载（0.18.0）：录三条响应 —— zip 来源真删目录、import 来源只注销、未登记 404。
  // 响应在录制期就是真实口径（note 由服务端按来源生成），回放只重放字节。
  const delZip = await rec('DELETE', '/api/capability/skills/rec-skill-zip', { token });
  assert.equal(delZip.status, 200, 'zip 来源卸载应成功：' + JSON.stringify(delZip.body).slice(0, 200));
  assert.equal(delZip.body.dirRemoved, true, 'zip 来源应连同安装目录删除');
  assert.ok(/删除/.test(delZip.body.note), 'zip 来源的 note 要说明目录已删');
  assert.ok(!fs.existsSync(smokeZipPath), '录制期就能证实：安装目录真的没了');
  const delImp = await rec('DELETE', '/api/capability/skills/rec-skill-import', { token });
  assert.equal(delImp.status, 200, 'import 来源卸载应成功：' + JSON.stringify(delImp.body).slice(0, 200));
  assert.equal(delImp.body.dirRemoved, false, 'import 来源不该删任何目录');
  assert.ok(/注销/.test(delImp.body.note) && /import/.test(delImp.body.note), 'note 要如实标注来源与"只注销登记"');
  const del404 = await rec('DELETE', '/api/capability/skills/rec-no-such-skill', { token });
  assert.equal(del404.status, 404, '未登记名应 404');
  assert.ok(/未登记/.test(del404.body.error.message), '404 文案要说清未登记');
});

/* ── 备份与恢复（P0-D 补页）：录制备份页要拉的接口 ─────────────────── */

await t('录制备份页数据：创建一次备份 + 列出 + 校验', async () => {
  const token = globalThis.__token;
  // 创建备份（App.createBackup 的调用路径）
  const c = await rec('POST', '/api/operation/backup', { token, saveAs: 'POST /api/operation/backup' });
  assert.equal(c.status, 200, JSON.stringify(c.body).slice(0, 200));
  assert.ok(c.body.file && c.body.manifest, '创建响应要有 file 与 manifest');

  // 列表（App.loadBackup 的调用路径）—— 必须在创建之后录，列表里才会含刚建的这个
  const l = await rec('GET', '/api/operation/backup', { token, saveAs: 'GET /api/operation/backup' });
  assert.equal(l.status, 200, JSON.stringify(l.body).slice(0, 200));
  assert.ok(Array.isArray(l.body.items) && l.body.items.length >= 1, '列表应含刚创建的备份');
  assert.ok(l.body.items.some((x) => x.file === c.body.file), '刚创建的备份必须出现在列表里');
  assert.ok(typeof l.body.dir === 'string', '列表要带回真实目录（前端会显示）');

  // 校验（App.verifyBackup 的调用路径；回放按 METHOD+path 取响应，不看 body）
  const v = await rec('POST', '/api/operation/backup/verify', {
    token, saveAs: 'POST /api/operation/backup/verify', body: { file: c.body.file },
  });
  assert.equal(v.status, 200);
  assert.equal(v.body.ok, true);
});

await t('录制 E3 素材：再建一份凑出"两份"，然后删掉先建的那份（DELETE 带真实文件名）', async () => {
  const token = globalThis.__token;
  // 复用上一条录到的第一份（下称 A）——此刻目录里只有它。
  const a = routes['GET /api/operation/backup'].body.items[0].file;
  // 再建一份 B：有它在，删 A 才不是"删最后一份"（最后一份是 409，录不到成功响应）。
  const b = await rec('POST', '/api/operation/backup', { token });
  assert.equal(b.status, 200, JSON.stringify(b.body).slice(0, 200));
  assert.notEqual(b.body.file, a, '两次备份落在同一毫秒会重名、后一份覆盖前一份 —— 先查这个再怪下面的断言');
  // 列表重录成"A、B 都在"的快照：回放页的删除按钮就落在它俩上，点删 A 命中下面那条真实成功响应。
  // ⚠️ 必须在删除**之前**录 —— 回放要点的按钮挂在 A 身上，列表里没有 A 就什么都点不到。
  const l = await rec('GET', '/api/operation/backup', { token, saveAs: 'GET /api/operation/backup' });
  assert.ok(l.body.items.some((x) => x.file === a) && l.body.items.some((x) => x.file === b.body.file),
    '重录的列表必须同时含 A、B 两份（回放删除按钮的渲染对象）');
  E3_DEL_NAME = a;
  // 删除 A 的真实成功响应 —— 回放里"确认删除"重放的就是它（含释放字节数 / 剩余份数 / 侧车字段）
  const del = await rec('DELETE', '/api/operation/backup/' + encodeURIComponent(a), { token });
  assert.equal(del.status, 200, '删除 A 应成功：' + JSON.stringify(del.body).slice(0, 200));
  assert.equal(del.body.name, a);
  assert.ok(del.body.bytes > 0, '响应要带回真实释放字节数');
  assert.equal(del.body.freedKey, false, 'API 备份无一次性密钥侧车（录制装配走的是主密钥路径）');
  assert.equal(del.body.remaining, 1, '删掉 A 后应恰剩 B 一份');
});

/* ── 部门（B8）：录一条创建，让账号页的"新建部门"动作用例有真实响应可回放 ── */

await t('录制部门数据：建一个部门（账号页「新建部门」的调用路径）', async () => {
  const token = globalThis.__token;
  const c = await rec('POST', '/api/identity/departments', {
    token, saveAs: 'POST /api/identity/departments', body: { name: '前端回归部门' },
  });
  assert.equal(c.status, 201, JSON.stringify(c.body).slice(0, 300));
  assert.ok(c.body.department.id, '建部门响应要带回 id');
  assert.equal(c.body.department.memberCount, 0, '新建部门的成员数是 0（数字）');
});

await t('录制账号页删除入口的数据源：用户列表里要有"别人"（删除按钮不给自己渲染）', async () => {
  const token = globalThis.__token;
  // 建账号（App.createUser 的调用路径）：之前用户列表只有 owner 一个人，
  // 删除按钮对"自己"不渲染 —— 列表里没有别人，回放页就永远测不到这个入口。
  // ⚠️ 必须放在「录制用户组数据」**之前**：那段结尾会把组删掉（成员连带清空），
  //    若在它之后覆盖用户列表，组带来的角色信息就丢了。
  const c = await rec('POST', '/api/identity/users', {
    token, saveAs: 'POST /api/identity/users',
    body: { username: 'rec-editor', password: 'R3c-Editor-Pass!', displayName: '回归专用账号' },
  });
  assert.equal(c.status, 201, '建账号应 201：' + JSON.stringify(c.body).slice(0, 200));
  const u = await rec('GET', '/api/identity/users?limit=200', { token, saveAs: 'GET /api/identity/users' });
  assert.ok(u.body.users.length >= 2, '用户列表应至少两个账号');
  assert.ok(u.body.users.some((x) => x.username === 'rec-editor'), '新账号应在清单里');
});

/* ── 用户组（P0-D #8）：录制组页要拉的接口 ───────────────────────── */

await t('录制用户组数据：建组 + 挂角色 + 加成员（用户列表要带出"所属组"）', async () => {
  const token = globalThis.__token;

  // 建组（App.createGroup 的调用路径）
  const c = await rec('POST', '/api/identity/groups', {
    token, saveAs: 'POST /api/identity/groups', body: { name: '前端回归组', description: '由 test-frontend 录制' },
  });
  assert.equal(c.status, 201, JSON.stringify(c.body).slice(0, 300));
  const gid = c.body.group.id;
  assert.ok(gid, '建组响应要带回组 id');
  globalThis.__groupId = gid;      // 回放期的 PUT/DELETE 键要带同一个 id

  // 挂角色（App.editGroupRoles 的调用路径）—— viewer 是只读角色，用它当探针
  const r = await rec('PUT', '/api/identity/groups/' + gid + '/roles', {
    token, saveAs: 'PUT /api/identity/groups/' + gid + '/roles', body: { roles: ['viewer'] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));

  // 加成员（App.editGroupMembers 的调用路径）：把发起录制的 owner 本人放进组
  // （列表里现在还有 rec-editor —— 不能按 users[0] 取，排序不是契约）
  const users0 = await rec('GET', '/api/identity/users?limit=200', { token, saveAs: 'GET /api/identity/users#pre' });
  const admin = users0.body.users.find((x) => x.username === ORG.username);
  assert.ok(admin, '用户列表里应有发起录制的 owner（' + ORG.username + '）');
  const m = await rec('PUT', '/api/identity/groups/' + gid + '/members', {
    token, saveAs: 'PUT /api/identity/groups/' + gid + '/members', body: { userIds: [admin.id] },
  });
  assert.equal(m.status, 200, JSON.stringify(m.body).slice(0, 300));
  assert.equal(m.body.group.members.length, 1, '组详情要带回成员');
  assert.equal(m.body.group.roles[0], 'viewer', '组详情要带回它持有的角色');

  // 组列表（App.loadGroups 的调用路径）
  const l = await rec('GET', '/api/identity/groups', { token, saveAs: 'GET /api/identity/groups' });
  assert.equal(l.status, 200);
  assert.ok(l.body.groups.some((x) => x.id === gid && (x.roles || []).includes('viewer')),
    '组列表要带上该组持有的角色（否则页面只能显示"无权限"）');
  assert.ok(l.body.groups.some((x) => x.id === gid && x.memberCount === 1), '组列表要带成员数');

  // 重新录用户列表：用户身上应带 groups、且生效角色是**并集**（owner 直接持有 + viewer 来自组）
  const users1 = await rec('GET', '/api/identity/users?limit=200', { token, saveAs: 'GET /api/identity/users' });
  const u = users1.body.users.find((x) => x.id === admin.id);
  assert.ok((u.groups || []).some((x) => x.id === gid), '用户列表要带出所属组');
  assert.ok((u.roles || []).includes('owner'), '直接持有的 owner 不能被组覆盖掉');
  assert.ok((u.roles || []).includes('viewer'), '组带来的 viewer 必须出现在生效角色里');

  // 改名 / 改说明（App.renameGroup / App.editGroupDesc 的调用路径）。
  // ⚠️ 必须打在两组 GET fixtures **之后**：回放里弹层的预填值取自组列表 fixture，
  //    提前改名会把预填值一起改掉，两个用例就分不清测的是哪份数据了。
  // 两个动作共用同一个 PUT 键（后录的覆盖先录的）：回放断言不依赖响应体里的名字，
  // 而依赖"弹层里显示什么、请求体带什么"，所以覆盖无碍。
  const rn = await rec('PUT', '/api/identity/groups/' + gid, {
    token, saveAs: 'PUT /api/identity/groups/' + gid, body: { name: '前端回归组（改后）' },
  });
  assert.equal(rn.status, 200, JSON.stringify(rn.body).slice(0, 300));
  assert.equal(rn.body.group.name, '前端回归组（改后）', '改名响应要带回新名字');
  assert.equal(rn.body.group.description, '由 test-frontend 录制', '改名不碰说明（未传的字段不该被动）');

  // 改说明到空串：空串是**有效值**（清空说明），不等于"没改" —— 实测锁定服务端语义。
  const rd = await rec('PUT', '/api/identity/groups/' + gid, {
    token, saveAs: 'PUT /api/identity/groups/' + gid, body: { description: '' },
  });
  assert.equal(rd.status, 200, JSON.stringify(rd.body).slice(0, 300));
  assert.equal(rd.body.group.description, '', '清空说明：响应里说明应为空串');
  assert.equal(rd.body.group.name, '前端回归组（改后）', '清空说明不碰组名');

  // 删组（App.deleteGroup 的调用路径）：响应只用于"调用成功"，回放不重建状态
  const del = await rec('DELETE', '/api/identity/groups/' + gid, { token, saveAs: 'DELETE /api/identity/groups/' + gid });
  assert.equal(del.status, 200, JSON.stringify(del.body).slice(0, 200));
  assert.ok(del.body.removedMembers >= 1, '删组响应应如实报出连带清掉的成员数');
});

/* ── 改姓名（C2）：给 PUT users/:id 录一条 fixture ───────────────────
   此前全站没有这条键 —— setUserDept 的用例只因"只断言调用发生"才能带 404 通过。
   ⚠️ 必须放在组录制**之后**：上面 :685 的 `GET /api/identity/users` fixture 是
   账号页回放的数据源，这里改了姓名后再录会把预填断言的数据一起改掉。 */

await t('录制账号改名：PUT users/:id 只带 displayName，不动其它字段', async () => {
  const token = globalThis.__token;
  const list = await rec('GET', '/api/identity/users?limit=200', { token, saveAs: 'GET /api/identity/users#name-pre' });
  const editor = list.body.users.find((x) => x.username === 'rec-editor');
  assert.ok(editor, '前置：用户列表里应有 rec-editor');
  const r = await rec('PUT', '/api/identity/users/' + editor.id, {
    token, saveAs: 'PUT /api/identity/users/' + editor.id, body: { displayName: '回归专用账号（改后）' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.user.displayName, '回归专用账号（改后）', '改名响应要带回新姓名');
  assert.equal(r.body.user.username, 'rec-editor', '登录账号不是改姓名会碰的字段');
  assert.equal(r.body.user.status, 'active', '未传的字段（状态）不该被动');
});

/* ── 模型中心（P1-1）：录制该页要拉的接口与动作 ─────────────────────── */

await t('录制模型中心：登记对话/向量条目 + 设默认 + 启停 + 探活（含真实失败与跳过）+ 删除', async () => {
  const token = globalThis.__token;

  // 先建一条"待删"的：这样最后录到的 POST create 是真正要留在列表里的那条，
  // 回放时点"登记"弹出的反馈名才对得上（POST create 共用一个键，后录的覆盖先录的）。
  const c = await rec('POST', '/api/model/providers', {
    token, saveAs: 'POST /api/model/providers',
    body: { name: '录制待删条目', kind: 'chat', protocol: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'tmp' },
  });
  assert.equal(c.status, 201, JSON.stringify(c.body).slice(0, 300));
  const idC = c.body.provider.id;
  globalThis.__modelDeleteId = idC;
  const del = await rec('DELETE', '/api/model/providers/' + idC, {
    token, saveAs: 'DELETE /api/model/providers/' + idC,
  });
  assert.equal(del.status, 200, JSON.stringify(del.body).slice(0, 200));
  assert.equal(del.body.deleted, '录制待删条目');

  // 对话条目（设为默认）。**带上单价**（P1-3）：这样"模型页的单价列"与
  // "配额页的成本面板"两边都有真实数据可渲染，不必在回放里造桩。
  // 单位是"最小货币单位 / 每 100 万 token"，所以这里就是 1 分/token、2 分/token。
  const a = await rec('POST', '/api/model/providers', {
    token, saveAs: 'POST /api/model/providers',
    body: { name: '录制对话模型', kind: 'chat', protocol: 'anthropic-messages',
      baseUrl: 'http://127.0.0.1:1', model: 'rec-chat', priority: 10, isDefault: true, label: '回归录制',
      currency: 'CNY', priceInMinor: 1000000, priceOutMinor: 2000000 },
  });
  assert.equal(a.status, 201, JSON.stringify(a.body).slice(0, 300));
  const idA = a.body.provider.id;
  assert.equal(a.body.provider.isDefault, true, 'isDefault 要真的落到库里');
  assert.equal(a.body.provider.hasCredential, false, '没填凭据名时应如实报"无"');
  assert.equal(a.body.provider.priced, true);
  assert.equal(a.body.provider.priceCacheReadMinor, null, '没配的缓存价必须是 null，不是 0');

  // 向量条目（设为默认）。baseUrl 指向一个**必然被拒**的端口 ——
  // 这样探活能走"真实失败"路径，而不是伪造一个成功。
  const b = await rec('POST', '/api/model/providers', {
    token, saveAs: 'POST /api/model/providers',
    body: { name: '录制向量模型', kind: 'embedding', protocol: 'openai-compat',
      baseUrl: 'http://127.0.0.1:1', model: 'rec-embed', priority: 20, isDefault: true },
  });
  assert.equal(b.status, 201, JSON.stringify(b.body).slice(0, 300));
  const idB = b.body.provider.id;
  assert.ok(b.body.provider.endpoint && /\/v1\/embeddings$/.test(b.body.provider.endpoint),
    '接口应算出真实端点（运维要能看到"到底打哪个地址"）：' + b.body.provider.endpoint);

  // "显式不配向量"条目 —— 探活必须给 skipped 而不是 fail（两者不能混为一谈）
  const d = await rec('POST', '/api/model/providers', {
    token, saveAs: 'POST /api/model/providers',
    body: { name: '录制不配向量', kind: 'embedding', protocol: 'none', priority: 90 },
  });
  assert.equal(d.status, 201, JSON.stringify(d.body).slice(0, 300));
  const idD = d.body.provider.id;
  globalThis.__modelIds = { chat: idA, embed: idB, none: idD };

  // 设默认（App.setModelDefault 的调用路径）。两条都录：页面上的"设为默认"按钮
  // 只对**非默认**项出现，因此两条键都要在，回放才不依赖"当前谁是默认"。
  const s = await rec('POST', '/api/model/providers/' + idB + '/default',
    { token, saveAs: 'POST /api/model/providers/' + idB + '/default' });
  assert.equal(s.status, 200, JSON.stringify(s.body).slice(0, 200));
  assert.equal(s.body.provider.isDefault, true);

  // 启停（App.toggleModel 的调用路径）录在 D 上 —— 它是"不配向量"，不是默认项，
  // 这样录制的副作用不会动到 A/B 的默认标记（否则回放时页面显示的默认会是另一个）。
  const off = await rec('POST', '/api/model/providers/' + idD + '/enabled',
    { token, saveAs: 'POST /api/model/providers/' + idD + '/enabled', body: { enabled: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.provider.enabled, false);
  const on = await rec('POST', '/api/model/providers/' + idD + '/enabled',
    { token, saveAs: 'POST /api/model/providers/' + idD + '/enabled', body: { enabled: true } });
  assert.equal(on.body.provider.enabled, true, '再启用后应为启用');

  // 探活：向量条目（真失败）与"不配向量"条目（预期跳过）各录一条
  const pB = await rec('POST', '/api/model/providers/' + idB + '/probe',
    { token, saveAs: 'POST /api/model/providers/' + idB + '/probe' });
  assert.equal(pB.status, 200, JSON.stringify(pB.body).slice(0, 200));
  assert.equal(pB.body.verdict.level, 'fail', '指向必拒端口的探活必须如实失败');
  assert.ok(/unreachable/.test(pB.body.verdict.code || ''), '失败要分类到"不可达"：' + pB.body.verdict.code);

  const pD = await rec('POST', '/api/model/providers/' + idD + '/probe',
    { token, saveAs: 'POST /api/model/providers/' + idD + '/probe' });
  assert.equal(pD.body.verdict.level, 'skipped', '"不配向量"是预期状态，必须与失败区分');
  assert.equal(pD.body.verdict.billedRequest, false, '跳过不发请求，因此不应标"已产生用量"');

  // 最后录列表：此时应含 3 条（对话 1 + 向量 2），且带默认与链
  const l = await rec('GET', '/api/model/providers', { token, saveAs: 'GET /api/model/providers' });
  assert.equal(l.status, 200);
  assert.equal(l.body.providers.length, 3, '列表应有 3 条（待删那条已删）');
  assert.equal(l.body.chain.chat.defaultSource, 'explicit', '对话默认应是显式设置的那条');
  assert.equal(l.body.chain.embedding.chain.length, 2, '向量链应有 2 条启用项');
  assert.ok(/不做请求转发/.test(l.body.status.boundaries || ''), '状态里必须带"不做转发"的边界说明');
});

/* ── 成本核算（P1-3 · 4.4）：先造出"带模型归因的真实用量"，再录成本接口 ─────── */

await t('录制成本：会话选模型 → 一轮对话 → 金额按单价算出；没选模型的会话进「未归因」', async () => {
  const token = globalThis.__token;
  const ids = globalThis.__modelIds;

  // 会话 A：建的时候就指定模型名 `rec-chat`（= 上面那条对话条目的「模型名」，
  // 归因就是靠这个字符串匹配的）。
  const sA = await rec('POST', '/api/kernel/sessions', {
    token, saveAs: 'POST /api/kernel/sessions',
    body: { title: '成本录制会话', model: 'rec-chat', provider: 'anthropic-messages' },
  });
  assert.equal(sA.status, 201, JSON.stringify(sA.body).slice(0, 200));
  assert.equal(sA.body.session.modelId, 'rec-chat', '建会话时的模型选择必须落库（否则用量无从归因）');

  // 会话 B：**不**指定模型 → 它那一轮用量必须进「未归因」桶。
  // 这条对照是整段的重点：没有它，"归因"能不能区分"没选模型"就测不出来。
  const sB = await rec('POST', '/api/kernel/sessions', { token, body: { title: '未选模型录制会话' } });
  assert.equal(sB.status, 201, JSON.stringify(sB.body).slice(0, 200));
  assert.equal(sB.body.session.modelId, '', '没选模型就是空串 —— 不偷偷填默认模型');

  // 会话详情也要录（工作台右侧上下文会拉它），顺便确认 modelId 出得来
  for (const [sid, expect] of [[sA.body.session.id, 'rec-chat'], [sB.body.session.id, '']]) {
    const g = await rec('GET', '/api/kernel/sessions/' + sid, { token });
    assert.equal(g.status, 200);
    assert.equal(g.body.session.modelId, expect, '会话详情要如实带出登记的模型名');
  }

  // 各跑一轮（测试替身是确定性脚本：input 128 / output 64 / reasoning 16）
  const tA = await rec('POST', '/api/kernel/sessions/' + sA.body.session.id + '/turns',
    { token, body: { content: '成本录制 A' } });
  assert.equal(tA.status, 200, JSON.stringify(tA.body).slice(0, 200));
  assert.equal(tA.body.usageCollected.written, 1);
  const tB = await rec('POST', '/api/kernel/sessions/' + sB.body.session.id + '/turns',
    { token, body: { content: '成本录制 B' } });
  assert.equal(tB.status, 200, JSON.stringify(tB.body).slice(0, 200));
  assert.equal(tB.body.usageCollected.written, 1);

  // ⚠️ 用量与成本**一起重录**：上面那两轮是本脚本里唯一的真实用量来源，
  //    而 `GET /api/governance/usage` 早先录的是"还没有用量"的状态。
  //    两者不一致的页面（用量空态 + 成本有数字）在真实世界里不可能出现，
  //    录出一个自相矛盾的快照，回放就只能测出假问题。
  const usage = await rec('GET', '/api/governance/usage', { token });
  assert.equal(usage.status, 200);
  assert.ok(usage.body.totals.billableInput > 0, '重录后的用量必须真的有数字');
  assert.equal(usage.body.byUser.length, 1, '两轮都记在同一个用户下');

  const cost = await rec('GET', '/api/governance/cost', { token });
  assert.equal(cost.status, 200, JSON.stringify(cost.body).slice(0, 300));
  const item = (cost.body.summary.items || []).find((x) => x.modelId === 'rec-chat');
  assert.ok(item, '要能归因到 rec-chat：' + JSON.stringify((cost.body.summary.items || []).map((x) => x.modelId)));
  assert.equal(item.amountMinor, 256, '128×1 分 + 64×2 分 = 256 分，实际 ' + item.amount);
  assert.equal(item.amount, 'CNY 2.56');
  assert.equal(cost.body.summary.unattributed.tokens, 192, '会话 B 那一轮（192 token）进未归因桶');
  assert.equal(cost.body.summary.mixedCurrency, false);
  assert.ok(/不是 0/.test(cost.body.semantics.unpriced), '口径要随数据一起录下来（回放页会渲染它）');

  // 最后录「改单价」这条动作路径（App.setModelPrice → PUT）。
  // 放在最后是为了不动上面已经录好的列表与成本快照 ——
  // 回放时这次 PUT 之后重新拉到的仍是旧快照，这是**录制方式的产物**，不是代码缺陷；
  // 所以对应的用例只断言"请求真的发出去了 + 有可见反馈"。
  const put = await rec('PUT', '/api/model/providers/' + ids.chat, {
    token, saveAs: 'PUT /api/model/providers/' + ids.chat,
    body: { currency: 'CNY', priceInMinor: 2000000, priceOutMinor: 2000000 },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body).slice(0, 300));
  assert.equal(put.body.provider.priceInMinor, 2000000);
  assert.equal(put.body.provider.priceCacheReadMinor, null, '没配的缓存价仍是 null');
});

/* ── 工作台最后一公里（P1-3 · 3.6）：录制附件 / 停止 ───────────────── */

await t('录制工作台 3.6：上传文本+二进制附件、列附件、停止', async () => {
  const token = globalThis.__token;

  const s = await rec('POST', '/api/kernel/sessions', {
    token, body: { title: '工作台 3.6 录制会话' },
  });
  assert.equal(s.status, 201, JSON.stringify(s.body).slice(0, 200));
  const sid = s.body.session.id;
  const base36 = '/api/kernel/sessions/' + sid;

  // 附件上传是**原始字节**（元数据走 query），录制器只会发 JSON —— 这里单开一个原始请求。
  // 录到的响应形状就是回放时前端要解析的那个形状，所以下面逐字段断言一遍。
  async function recUpload(filename, buf, saveAs) {
    const res = await fetch(svc.base + base36 + '/attachments?filename=' + encodeURIComponent(filename), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/octet-stream' },
      body: buf,
    });
    const body = await res.json();
    routes[saveAs || 'POST ' + base36 + '/attachments'] = { status: res.status, body };
    recorded.push((saveAs || 'POST ' + base36 + '/attachments') + ' → ' + res.status);
    return { status: res.status, body };
  }

  const txt = await recUpload('规格.txt', Buffer.from('回归录制：关键常量是 REC-36。', 'utf8'));
  assert.equal(txt.status, 201, JSON.stringify(txt.body).slice(0, 300));
  assert.equal(txt.body.attachment.kind, 'text');
  assert.equal(txt.body.injectable, true);
  assert.ok(/内容/.test(txt.body.semantics.kind), '口径文案要录下来（回放页会渲染）');
  assert.equal(txt.body.attachment.bytes, Buffer.byteLength('回归录制：关键常量是 REC-36。', 'utf8'));

  const bin = await recUpload('图.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  assert.equal(bin.body.attachment.kind, 'binary', '含 NUL → binary，判据是内容不是扩展名');
  assert.equal(bin.body.injectable, false);
  // 注意这个文件的**名字**叫「图.png」但字节不是真 PNG（魔数只对了前 4 个）。
  // 上一版会按名字/声明把它当图片；现在按内容判 → 认不出白名单格式 → 走文件通路。
  assert.equal(bin.body.delivery.mode, 'none', '名字像图片但内容不是 → 不许猜，退回文件通路');

  // 真 PNG：作为图片内容块送给模型的那一类。录制形状供回放页渲染。
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64');
  const img = await recUpload('真图.png', PNG_1x1);
  assert.equal(img.status, 201, JSON.stringify(img.body).slice(0, 300));
  assert.equal(img.body.attachment.mime, 'image/png', 'mime 是按魔数嗅探出的真实类型');
  assert.equal(img.body.delivery.mode, 'image');
  assert.equal(img.body.injectable, false, '图片不走"文本注入"那条路 —— 它是另一条通路，两者别混');

  const list = await rec('GET', base36 + '/attachments', { token });
  assert.equal(list.status, 200);
  assert.equal(list.body.count, 3);
  assert.ok(list.body.limits && list.body.limits.maxBytes > 0, '上限要随列表回给前端');
  assert.ok(list.body.limits.imageTotalMax > 0, '图片的本轮合计上限也要回给前端（用户才知道为什么"发不出去"）');
  assert.equal(JSON.stringify(list.body).includes('uploads/'), false, '响应里不许出现存储路径');
  // 列表要**直接给出**"发送时会怎样"，前端不该自己按扩展名/大小再推一遍（那会变成第二个真相）
  assert.deepEqual(list.body.items.map((x) => x.delivery), ['text', 'none', 'image'],
    '每个附件都要带服务端判定的 delivery（三种结局：注入正文 / 不交给模型 / 作为图片送给模型）');

  // 跑一轮把附件的注入写进事件流（回放时"用户气泡剥掉注入段"要靠这个真实形态）。
  // 三个都带上：这样落库正文里同时有 `<attachment ` 引用块与图片清单行，
  // 回放段才能验证气泡上那两行数字是从**原文**里读出来的。
  const turn = await rec('POST', base36 + '/turns', {
    token,
    body: {
      content: '请阅读附件 REC-36',
      attachmentIds: [txt.body.attachment.id, bin.body.attachment.id, img.body.attachment.id],
    },
  });
  assert.equal(turn.status, 200, JSON.stringify(turn.body).slice(0, 300));
  assert.deepEqual(turn.body.attachments.injected.map((x) => x.id), [txt.body.attachment.id]);
  assert.deepEqual(turn.body.attachments.skipped.map((x) => x.id), [bin.body.attachment.id]);
  assert.deepEqual(turn.body.attachments.sent.map((x) => x.id), [img.body.attachment.id],
    '图片要出现在 sent 里 —— 上一版它会躺在 skipped 里（"平台没有上传通道"那个错误结论）');
  const start = (turn.body.events || []).find((e) => e.type === 'turn-start');
  assert.ok(start && start.text.includes('<<<STI-ATTACHMENTS>>>'), '注入标记必须真的落在事件里');
  assert.ok(start.text.includes('REC-36'), '附件正文必须真的进了 prompt');
  assert.ok(/本轮随附 1 张图片/.test(start.text), '图片清单行必须落在事件里（回放靠它数图）');

  const ev = await rec('GET', base36 + '/events', { token });
  assert.equal(ev.status, 200);

  // 0.21.7：这里原来还录一条 `GET …/search`（会话内检索）。检索已**整块删除**
  //（服务端路由 + 仓储函数 + 前端面板 + 命中高亮），所以录制也一起去掉 ——
  // 留着录制会让回放页挂着一个界面上永远打不到的路由，那种"看起来还在"的残留
  // 正是删除时要清掉的东西。

  // 停止（前端 wbStop 会打这个端点）
  const cancel = await rec('POST', base36 + '/cancel', { token, body: { turnId: 'kt-rec-1' } });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body).slice(0, 300));
  assert.equal(cancel.body.upstream.attempted, true);
  assert.ok(/已落库|丢弃/.test(cancel.body.note), '停止的语义要随响应录下来');

  // 把录制到的 id 交给回放段：回放不能凭空编 id，否则"点下载/删除打到哪个附件"就无从验证
  globalThis.__wb36 = {
    sid, textId: txt.body.attachment.id, binId: bin.body.attachment.id, imgId: img.body.attachment.id,
  };
});

/* ── 调度中心 与 通知渠道（P1-2）：录制这两页要拉的接口与动作 ───────── */

await t('录制调度中心：建任务 / 立即执行 / 启停 / 手动扫描 / 删除', async () => {
  const token = globalThis.__token;

  // 先建一条"待删"的：这样最后留在列表里的两条是真正要展示的，
  // 回放时点"删除"弹出的反馈名才对得上（POST 共用一个键，后录的覆盖先录的）。
  const del1 = await rec('POST', '/api/schedule/jobs', {
    token, saveAs: 'POST /api/schedule/jobs',
    body: { name: '录制待删任务', kind: 'audit.anchor', schedule: 'dailyAt:02:00' },
  });
  assert.equal(del1.status, 201, JSON.stringify(del1.body).slice(0, 300));
  const delId = del1.body.job.id;
  globalThis.__jobDeleteId = delId;
  const d = await rec('DELETE', '/api/schedule/jobs/' + delId, {
    token, saveAs: 'DELETE /api/schedule/jobs/' + delId,
  });
  assert.equal(d.status, 200, JSON.stringify(d.body).slice(0, 200));
  assert.equal(d.body.deleted, '录制待删任务');

  // 留在列表里的任务：审计归档（执行体依赖 governance，这是真的能跑的）
  const j = await rec('POST', '/api/schedule/jobs', {
    token, saveAs: 'POST /api/schedule/jobs',
    body: { name: '录制审计归档', kind: 'audit.archive', schedule: 'interval:3600000' },
  });
  assert.equal(j.status, 201, JSON.stringify(j.body).slice(0, 300));
  const jobId = j.body.job.id;
  globalThis.__jobIds = { main: jobId };
  assert.ok(j.body.job.nextRunAt, '新建时服务端就要算出下次执行时间');
  assert.match(j.body.job.scheduleText, /每 1 小时/, '规则要带人话说明：' + j.body.job.scheduleText);

  // 立即执行（App.runJob 的调用路径）。此刻没有超期记录 → 服务端应如实回 skipped。
  // 录这条的价值正在于此：页面上要显示"无待处理"，而不是一个红色的"失败"。
  const run = await rec('POST', '/api/schedule/jobs/' + jobId + '/run',
    { token, saveAs: 'POST /api/schedule/jobs/' + jobId + '/run' });
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 300));
  assert.equal(run.body.status, 'skipped', '没有超期记录时执行结果是 skipped（"没事干"不是失败）');
  assert.equal(run.body.job.lastDetail.manual, true, '手动执行必须与定时触发可区分');

  // 启停（App.toggleJob 的调用路径）。两条都录，键相同 —— 后录的（启用）是终态。
  const off = await rec('PUT', '/api/schedule/jobs/' + jobId, {
    token, saveAs: 'PUT /api/schedule/jobs/' + jobId, body: { enabled: false },
  });
  assert.equal(off.status, 200, JSON.stringify(off.body).slice(0, 200));
  const on = await rec('PUT', '/api/schedule/jobs/' + jobId, {
    token, saveAs: 'PUT /api/schedule/jobs/' + jobId, body: { enabled: true },
  });
  assert.equal(on.body.job.enabled, true);
  assert.ok(on.body.job.nextRunAt, '重新启用后要带上下次执行时间');

  // 手动扫描一次（App.tickNow 的调用路径）
  const tick = await rec('POST', '/api/schedule/tick', { token, saveAs: 'POST /api/schedule/tick' });
  assert.equal(tick.status, 200, JSON.stringify(tick.body).slice(0, 200));
  assert.ok(tick.body.tick && typeof tick.body.tick.due === 'number');

  // 最后录列表：此刻应只剩 1 条（待删那条已删），并且带调度器状态与执行体说明
  const l = await rec('GET', '/api/schedule/jobs', { token, saveAs: 'GET /api/schedule/jobs' });
  assert.equal(l.status, 200);
  assert.equal(l.body.jobs.length, 1, '列表应只剩 1 条（待删那条已删）');
  assert.ok(l.body.status.boundaries && /UTC/.test(l.body.status.boundaries),
    '边界说明要随数据返回（dailyAt 按 UTC 解释这件事必须写在页面上）');
  assert.ok(Array.isArray(l.body.status.kinds) && l.body.status.kinds.includes('backup.create'),
    '执行体白名单要下发，页面才能渲染「可用的执行体」表与新建下拉');

  // 行内编辑（C3）：PUT 是全字段部分更新 —— 录一条"改名 + 改规则 + 改参数"的真实提交。
  // ⚠️ 两条纪律：① 必须放在最后的 GET **之后**：把它放前面，列表页显示的就是改后的值，
  //    会连带改掉上面「规则显示成人话（每 1 小时）」那条既有断言；
  //    ② PUT 与前面的启停**共用一个键**（后录的覆盖先录的），因此这条是**终态**：
  //    回放时 toggleJob 与 saveJob 拿到的都是这条响应。
  const ed = await rec('PUT', '/api/schedule/jobs/' + jobId, {
    token, saveAs: 'PUT /api/schedule/jobs/' + jobId,
    body: {
      name: '录制审计归档（改后）', kind: 'audit.archive',
      schedule: 'interval:7200000', params: { retentionDays: 30 },
    },
  });
  assert.equal(ed.status, 200, JSON.stringify(ed.body).slice(0, 300));
  assert.equal(ed.body.job.name, '录制审计归档（改后）');
  assert.equal(ed.body.job.schedule, 'interval:7200000');
  assert.match(ed.body.job.scheduleText, /每 2 小时/, '改规则后要重算人话说明');
  assert.ok(ed.body.job.nextRunAt, '改规则后要重算下次执行时间');
  assert.deepEqual(ed.body.job.params, { retentionDays: 30 }, '参数改动要落库并回显');
  assert.equal(ed.body.job.enabled, true, '部分更新不该动没提交的字段（enabled 未提交，应保持原值）');
});

await t('录制通知渠道：登记（URL 加密）/ 试发成功 / 启停 / 删除', async () => {
  const token = globalThis.__token;

  // 桩服务器：让"试发"走一次**真实** HTTP 往返，而不是录一个伪造的成功。
  // 本套回归的 notify 装配开了 allowLoopback，因此能真的投递到 127.0.0.1。
  const stub = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const hookUrl = 'http://127.0.0.1:' + stub.address().port + '/hook?access_token=FE-SUPER-SECRET-TOKEN';
  try {
    // 待删渠道
    const del1 = await rec('POST', '/api/notify/channels', {
      token, saveAs: 'POST /api/notify/channels',
      body: { name: '录制待删渠道', url: 'http://10.0.0.9/hook', events: ['quota.blocked'] },
    });
    assert.equal(del1.status, 201, JSON.stringify(del1.body).slice(0, 300));
    const delId = del1.body.channel.id;
    globalThis.__chanDeleteId = delId;
    const dd = await rec('DELETE', '/api/notify/channels/' + delId, {
      token, saveAs: 'DELETE /api/notify/channels/' + delId,
    });
    assert.equal(dd.status, 200, JSON.stringify(dd.body).slice(0, 200));
    assert.equal(dd.body.deleted, '录制待删渠道');

    // 留在列表里的渠道：URL 带 token，服务端只能回显 host
    const c = await rec('POST', '/api/notify/channels', {
      token, saveAs: 'POST /api/notify/channels',
      body: { name: '录制运维群', url: hookUrl, events: ['quota.blocked', 'audit.anchor'], credentialName: '' },
    });
    assert.equal(c.status, 201, JSON.stringify(c.body).slice(0, 300));
    const chanId = c.body.channel.id;
    globalThis.__chanIds = { main: chanId };
    assert.ok(!/FE-SUPER-SECRET-TOKEN|access_token/.test(JSON.stringify(c.body)),
      '响应里绝不能出现完整 URL（它常内嵌机器人 token，等价于密钥）');
    assert.equal(c.body.channel.host, 'http://127.0.0.1:' + stub.address().port + '/…',
      '只回显 host，够运维认人即可');

    // 试发（App.testChannel 的调用路径）—— 真的往桩服务器发一次
    const t1 = await rec('POST', '/api/notify/channels/' + chanId + '/test',
      { token, saveAs: 'POST /api/notify/channels/' + chanId + '/test' });
    assert.equal(t1.status, 200, JSON.stringify(t1.body).slice(0, 300));
    assert.equal(t1.body.result.ok, true, '桩服务器返回 200，试发结论应是成功');
    assert.equal(t1.body.result.status, 200);

    // 启停（App.toggleChannel 的调用路径）。url 留空 = 不改动（避免"一保存就把密钥清掉"）。
    const off = await rec('PUT', '/api/notify/channels/' + chanId, {
      token, saveAs: 'PUT /api/notify/channels/' + chanId, body: { enabled: false },
    });
    assert.equal(off.status, 200, JSON.stringify(off.body).slice(0, 200));
    assert.equal(off.body.channel.hasUrl, true, '只改启停时，已存的 URL 必须还在');
    const on = await rec('PUT', '/api/notify/channels/' + chanId, {
      token, saveAs: 'PUT /api/notify/channels/' + chanId, body: { enabled: true },
    });
    assert.equal(on.body.channel.enabled, true);

    const l = await rec('GET', '/api/notify/channels', { token, saveAs: 'GET /api/notify/channels' });
    assert.equal(l.status, 200);
    assert.equal(l.body.channels.length, 1, '列表应只剩 1 条（待删那条已删）');
    assert.ok(!/FE-SUPER-SECRET-TOKEN/.test(JSON.stringify(l.body)), '清单同样不能回显 token');
    assert.ok(l.body.status.boundaries, '通知的诚实边界要随数据下发（投递语义 / 整体停机仍会丢 / 队列可见）');

    // 行内编辑（App.saveChannel 的调用路径）：改名字 + 轮换 URL + 整体替换订阅事件。
    // 放在最终 GET **之后**：回放里的列表断言都按上面那份快照，编辑不回头污染它们；
    // 用独立 saveAs 键（#edit），否则会覆盖同路径启停那两条录制 —— 回放里同路径的 PUT
    // 默认仍解析到启停那次，编辑类用例按需用 overrides 换取这一条。
    const ed = await rec('PUT', '/api/notify/channels/' + chanId, {
      token, saveAs: 'PUT /api/notify/channels/' + chanId + '#edit',
      body: { name: '录制运维群（改后）', url: 'http://10.0.0.7/rotated-hook', events: ['backup.failed', 'audit.anchor'] },
    });
    assert.equal(ed.status, 200, JSON.stringify(ed.body).slice(0, 200));
    assert.equal(ed.body.channel.name, '录制运维群（改后）');
    assert.equal(ed.body.channel.host, 'http://10.0.0.7/…', '换 URL 后只回显新 host');
    assert.deepEqual(ed.body.channel.events, ['backup.failed', 'audit.anchor'], '订阅列表整体替换');
    assert.equal(ed.body.channel.enabled, true, '只改名字/URL/订阅，不该动启停状态');
    assert.ok(!/rotated-hook|FE-SUPER-SECRET-TOKEN/.test(JSON.stringify(ed.body)), '换 URL 的响应同样不能回显完整 URL');
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

await t('录制投递失败队列：用真流程造出一条待重投记录，再录下它的形状', async () => {
  const token = globalThis.__token;
  // 为什么必须**录真的**：队列的形状（policy / queue / note / 每条记录字段）是新接口，
  // 手写桩一定会跟实现漂移。造 pending 的路径也是真流程：
  //   建渠道（指向**关闭的端口**；本套回归开了 allowLoopback）→ 手动跑一次 audit.anchor 任务
  //   → 它向该渠道出站 → 连接被拒 → 落队。
  // 用"连接被拒"而不是黑洞地址是为了**确定性**：ECONNREFUSED 立刻返回，不必等超时。
  const c = await rec('POST', '/api/notify/channels', {
    token, saveAs: 'POST /api/notify/channels#queue',
    body: { name: '录制队列桩', url: 'http://127.0.0.1:1/hook', events: ['audit.anchor'] },
  });
  assert.equal(c.status, 201, JSON.stringify(c.body).slice(0, 200));

  const j = await rec('POST', '/api/schedule/jobs', {
    token, saveAs: 'POST /api/schedule/jobs#queue',
    body: { name: '录制队列锚点', kind: 'audit.anchor', schedule: 'interval:60000' },
  });
  assert.equal(j.status, 201, JSON.stringify(j.body).slice(0, 200));
  const run = await rec('POST', '/api/schedule/jobs/' + j.body.job.id + '/run',
    { token, saveAs: 'POST /api/schedule/jobs/run#queue' });
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 200));

  const dl = await rec('GET', '/api/notify/deliveries?status=all&limit=100',
    { token, saveAs: 'GET /api/notify/deliveries' });
  assert.equal(dl.status, 200, JSON.stringify(dl.body).slice(0, 200));
  const row = (dl.body.deliveries || []).find((d) => d.channelName === '录制队列桩');
  assert.ok(row, '应录到一条**真实**的失败投递：' + JSON.stringify(dl.body.deliveries).slice(0, 300));
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0, 'attempts 只记已重投次数，首次失败时为 0');
  assert.equal(dl.body.policy.maxAttempts, 6, '重投上限要随清单下发');
  assert.ok(/at-least-once/.test(dl.body.note || ''), '投递语义要随清单下发');
  globalThis.__deliveryId = row.id;

  // 手动重投（App.redeliver 的调用路径）。目标仍关闭 → 结论是"仍未成功"，HTTP 仍 200。
  const rd = await rec('POST', '/api/notify/deliveries/' + row.id + '/redeliver',
    { token, saveAs: 'POST /api/notify/deliveries/' + row.id + '/redeliver' });
  assert.equal(rd.status, 200, JSON.stringify(rd.body).slice(0, 200));
  assert.equal(rd.body.result.status, 'pending', '目标仍不可达 → 保持待重投');
  assert.equal(rd.body.delivery.attempts, 1, '手动重投失败也记一次尝试');
});

/* ── 两步验证（TOTP）录制（0.17.0）────────────────────────────────────
   建一个独立账号 fe-mfa，用真实服务、真实时钟走完：登记 → 确认启用 →
   两步登录（错码被拒 / 动态码通过 / 恢复码通过）→ 管理员重置 → 单步登录
   回归 → 再登记 → 停用。录制结果供本文件后面的「两步验证」回放节使用。

   为什么独立账号：主 users fixture 是更早的快照，且账号页/组页用例都按它
   断言 —— 往那份快照里塞新账号会波及一片。需要"用户行带 totpEnabled"的地方
   改用下面的 `GET /api/identity/users#has-mfa` 专用快照（非破坏式录制，
   主键 `GET /api/identity/users` 不动）。

   步号预算：每个消费动态码的动作恰好推进一个步号（freshFrontendTotpCode 的
   lastUsed 链），同一 30 秒窗口内每个密钥最多连用 2 步 —— 再多会撞 ±1 窗口
   的一致性护栏、本文件报红提示重跑。恢复码登录**不**消费步号。
   有意不录「重新生成恢复码」：同一窗口第 3 个步号必破护栏，而那个按钮的
   存在性由回放侧 enabled 面板断言、wire 行为由 test-http.mjs 覆盖。 */
const MFA_USER = 'fe-mfa';
const MFA_PASS = 'Fe-Mfa-Totp!2345';

/** 算"当前窗口内、且比该密钥上次用过的步号更新"的动态码（与 test-http 同款护栏）。 */
function freshFrontendTotpCode(secretBase32, lastUsed = null) {
  const now = totpStepAt();
  const step = Math.max(now, (lastUsed == null ? -1 : Number(lastUsed)) + 1);
  assert.ok(step - totpStepAt() <= TOTP_WINDOW,
    '录制动作跨出了 TOTP 窗口（step=' + step + '），重跑即可');
  return { code: hotp(base32Decode(secretBase32), step), step };
}

/** 一个**确实不在**当前 ±1 窗口里的 6 位码：用来录"错码被真实拒绝"的那次响应。 */
function wrongFrontendTotpCode(secretBase32) {
  const s = totpStepAt();
  const taken = new Set([-2, -1, 0, 1, 2].map((d) => hotp(base32Decode(secretBase32), s + d)));
  for (let i = 0; ; i++) {
    const c = String(i).padStart(6, '0');
    if (!taken.has(c)) return c;
  }
}

let mfaUserId = '';
let mfaSecret1 = '';
let mfaStep1 = 0;
let mfaSecret2 = '';
let mfaRecoveryCodes = [];

await t('两步验证录制①：fe-mfa 登记 → 确认启用（真密钥 + 10 张一次性恢复码）', async () => {
  const token = globalThis.__token;
  const u = await rec('POST', '/api/identity/users', {
    token, saveAs: 'POST /api/identity/users#mfa',
    body: { username: MFA_USER, password: MFA_PASS, displayName: '两步回归账号' },
  });
  assert.equal(u.status, 201, JSON.stringify(u.body).slice(0, 300));
  mfaUserId = u.body.user.id;

  // 还没开启两步 → 登录是单步的；登记接口要的正是这个会话令牌。
  const l = await rec('POST', '/api/identity/login', {
    saveAs: 'POST /api/identity/login#fe-mfa-first',
    body: { username: MFA_USER, password: MFA_PASS },
  });
  assert.equal(l.status, 200, JSON.stringify(l.body).slice(0, 300));
  assert.ok(!l.body.twoFactorRequired, '未开启两步时登录不应要第二因子');
  const mfaToken = l.body.token;

  const e = await rec('POST', '/api/identity/totp/enroll', {
    token: mfaToken, saveAs: 'POST /api/identity/totp/enroll',
    body: { password: MFA_PASS },
  });
  assert.equal(e.status, 200, JSON.stringify(e.body).slice(0, 300));
  mfaSecret1 = e.body.enroll.secret;
  assert.ok(/^[A-Z2-7]{32}$/.test(mfaSecret1), '登记应返回 32 位 Base32 密钥');
  assert.ok(/^otpauth:\/\/totp\//.test(e.body.enroll.otpauthUri), '应给可扫码的 otpauth URI');

  const st = await rec('GET', '/api/identity/totp', { token: mfaToken, saveAs: 'GET /api/identity/totp#pending' });
  assert.equal(st.body.totp.pending, true, '确认前是 pending（尚未生效）');
  assert.equal(st.body.totp.enabled, false);

  const c1 = freshFrontendTotpCode(mfaSecret1);
  const cf = await rec('POST', '/api/identity/totp/confirm', {
    token: mfaToken, saveAs: 'POST /api/identity/totp/confirm',
    body: { code: c1.code },
  });
  assert.equal(cf.status, 200, JSON.stringify(cf.body).slice(0, 300));
  assert.equal(cf.body.enabled, true);
  assert.equal(cf.body.recoveryCodes.length, 10, '启用时一次性发 10 张恢复码');
  assert.ok(cf.body.recoveryCodes.every((x) => /^[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(x)),
    '恢复码是 XXXX-XXXX 形状（界面上要让人抄写）');
  mfaRecoveryCodes = cf.body.recoveryCodes.slice();
  mfaStep1 = c1.step;

  const se = await rec('GET', '/api/identity/totp', { token: mfaToken, saveAs: 'GET /api/identity/totp#enabled' });
  assert.equal(se.body.totp.enabled, true);
  assert.equal(se.body.totp.recoveryCodesLeft, 10);
});

await t('两步验证录制②：两步登录 —— 错码被拒 / 动态码通过 / 恢复码通过', async () => {
  const token = globalThis.__token;

  const l1 = await rec('POST', '/api/identity/login', {
    saveAs: 'POST /api/identity/login#mfa',
    body: { username: MFA_USER, password: MFA_PASS },
  });
  assert.equal(l1.status, 200);
  assert.equal(l1.body.twoFactorRequired, true, '开启后登录应回第二因子要求');
  assert.ok(l1.body.ticket, '口令步通过后应给一次性票据');
  assert.ok(!l1.body.token, '票据阶段**不能**下发会话令牌');

  const bad = await rec('POST', '/api/identity/login/totp', {
    saveAs: 'POST /api/identity/login/totp#bad',
    body: { ticket: l1.body.ticket, code: wrongFrontendTotpCode(mfaSecret1) },
  });
  assert.equal(bad.status, 401, '错码必须被真实拒绝，实际 ' + bad.status);

  const c2 = freshFrontendTotpCode(mfaSecret1, mfaStep1);
  const ok = await rec('POST', '/api/identity/login/totp', {
    saveAs: 'POST /api/identity/login/totp#ok',
    body: { ticket: l1.body.ticket, code: c2.code },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
  assert.ok(ok.body.token, '第二步通过应发会话令牌');
  assert.ok(!ok.body.viaRecoveryCode, '动态码登录不是恢复码路径');

  const l2 = await rec('POST', '/api/identity/login', {
    saveAs: 'POST /api/identity/login#mfa2',
    body: { username: MFA_USER, password: MFA_PASS },
  });
  assert.equal(l2.body.twoFactorRequired, true);
  const rc = await rec('POST', '/api/identity/login/totp', {
    saveAs: 'POST /api/identity/login/totp#recovery',
    body: { ticket: l2.body.ticket, code: mfaRecoveryCodes[0] },
  });
  assert.equal(rc.status, 200, JSON.stringify(rc.body).slice(0, 200));
  assert.equal(rc.body.viaRecoveryCode, true, '恢复码登录要如实标注');
  assert.equal(rc.body.recoveryCodesLeft, 9, '烧掉的那张要减掉');

  const us = await rec('GET', '/api/identity/users?limit=200', { token, saveAs: 'GET /api/identity/users#has-mfa' });
  const row = (us.body.users || []).find((x) => x.username === MFA_USER);
  assert.ok(row, '应能在用户列表里找到 fe-mfa');
  assert.equal(row.totpEnabled, true, '启用两步的账号，用户行要带 totpEnabled（界面徽标的数据源）');
});

await t('两步验证录制③：管理员重置 → 单步登录回归 → 再登记 → 停用', async () => {
  const token = globalThis.__token;
  const rs = await rec('POST', '/api/identity/users/' + mfaUserId + '/totp-reset', {
    token, saveAs: 'POST /api/identity/users/' + mfaUserId + '/totp-reset', body: {},
  });
  assert.equal(rs.status, 200, JSON.stringify(rs.body).slice(0, 200));
  assert.equal(rs.body.hadTotp, true);
  assert.equal(rs.body.codesRemoved, 10, '重置要把整批恢复码清掉');

  // 重置的承诺：下次登录只需口令。真跑一次来证明，而不是信文档。
  const l3 = await rec('POST', '/api/identity/login', {
    saveAs: 'POST /api/identity/login#fe-mfa-after-reset',
    body: { username: MFA_USER, password: MFA_PASS },
  });
  assert.equal(l3.status, 200);
  assert.ok(!l3.body.twoFactorRequired, '重置后登录回到单步（这正是重置的承诺）');
  const token2 = l3.body.token;

  const e2 = await rec('POST', '/api/identity/totp/enroll', {
    token: token2, saveAs: 'POST /api/identity/totp/enroll#2',
    body: { password: MFA_PASS },
  });
  assert.equal(e2.status, 200);
  mfaSecret2 = e2.body.enroll.secret;
  assert.notEqual(mfaSecret2, mfaSecret1, '重新登记要换新密钥（旧验证器随即失效）');

  const c4 = freshFrontendTotpCode(mfaSecret2);
  const cf2 = await rec('POST', '/api/identity/totp/confirm', {
    token: token2, saveAs: 'POST /api/identity/totp/confirm#2',
    body: { code: c4.code },
  });
  assert.equal(cf2.status, 200, JSON.stringify(cf2.body).slice(0, 200));
  assert.equal(cf2.body.enabled, true);

  const c5 = freshFrontendTotpCode(mfaSecret2, c4.step);
  const dis = await rec('POST', '/api/identity/totp/disable', {
    token: token2, saveAs: 'POST /api/identity/totp/disable',
    body: { password: MFA_PASS, code: c5.code },
  });
  assert.equal(dis.status, 200, JSON.stringify(dis.body).slice(0, 200));
  assert.equal(dis.body.enabled, false);

  const sd = await rec('GET', '/api/identity/totp', { token: token2, saveAs: 'GET /api/identity/totp#disabled' });
  assert.equal(sd.body.totp.enabled, false);
  assert.equal(sd.body.totp.recoveryCodesLeft, 0, '停用后恢复码一并作废');
});

await t('录制会话列表（补录）：改名/删除按钮要挂在真实会话行上', async () => {
  const token = globalThis.__token;
  // loadAll 期的第一份是空清单（那时一个会话都还没有）—— 成本/工作台/治理录制
  // 已经建了好几个会话，这里覆盖录制，回放页才有行可渲染行内入口
  const s = await rec('GET', '/api/kernel/sessions?limit=50', { token, saveAs: 'GET /api/kernel/sessions' });
  assert.equal(s.status, 200);
  assert.ok((s.body.items || []).length >= 1, '补录的会话清单应非空');
  SESSION_ID_FOR_LOG = s.body.items[0].id;   // 会话日志用例按这份清单的第一行下载
});

await t('录制会话日志导出：log.zip 是二进制，录到的应是真 ZIP 字节', async () => {
  const token = globalThis.__token;
  const path = '/api/governance/sessions/' + encodeURIComponent(SESSION_ID_FOR_LOG) + '/log.zip';
  const r = await rec('GET', path, { token, saveRaw: true });
  assert.equal(r.status, 200, '导出应答 200');
  // ⚠️ 必须是真字节而不是被解码毁掉的文本：ZIP 头固定 'PK'（0x50 0x4B）。
  //   早先用 `res.text()` 读时，字节会被 UTF-8 解码成 U+FFFD，回放里前端的 blob 也就不是 ZIP 了。
  const raw = Buffer.from(routes['GET ' + path]._b64 || '', 'base64');
  assert.equal(raw.slice(0, 2).toString('latin1'), 'PK', '录到的文件头应是 ZIP 魔数');
  assert.ok(raw.length > 200, 'ZIP 含 meta/session/events/artifacts 四个条目，不该只有几十字节');
});

await t('录制账号批量导入（补录）：报表形状来自真实服务，且任何响应都不得回显口令', async () => {
  const token = globalThis.__token;
  // 为什么放在录制阶段**最后**：导入会在库里真的建出账号，而账号列表的既有 fixture
  // （GET /api/identity/users）是更早的快照 —— 回放页的用例都按那份快照断言。
  // 录制次序本身就是隔离：这里之后不再录任何接口，新行不会漏进别的 fixture。
  const csv = [
    'username,password,displayName,dept,roles',
    'fe-imp-a,Fe-Imp-Aa!2345,前端导入甲,,member',
    'fe-imp-b,Fe-Imp-Bb!2345,前端导入乙,,member',
    'admin,Fe-Imp-Cc!2345,与根账号重名,,',
  ].join('\n') + '\n';
  const r = await rec('POST', '/api/identity/users/import', {
    token, saveAs: 'POST /api/identity/users/import', body: { csv },
  });
  assert.equal(r.status, 200, '导入应答 200：' + JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.report.total, 3);
  assert.equal(r.body.report.created, 2, '两行有效');
  assert.equal(r.body.report.failed, 1, 'admin 与根账号重名 → 该行失败');
  assert.deepEqual(r.body.report.rows.map((x) => x.line), [2, 3, 4], '报表要逐行给**物理行号**');
  assert.ok(r.body.report.rows.slice(0, 2).every((x) => x.ok && /^usr_/.test(x.id || '')),
    '成功行要带真实创建的账号 id');
  assert.ok(/已存在/.test(r.body.report.rows[2].error), '失败行的原因要是人话');
  assert.ok(!/Fe-Imp-Aa!2345|Fe-Imp-Bb!2345|Fe-Imp-Cc!2345/.test(JSON.stringify(r.body)),
    '报表（以及这条链上任何响应）不得回显口令');
});

/* 影子记录：已录到的这些响应，回放时按用例替换 */
routes['GET /api/identity/me#anon'] = { status: meAnonStatus, body: meAnonBody };
/* ══════════════════════════════════════════════════════════════════
   ② vm + DOM 垫片，回放驱动 app.js
   ══════════════════════════════════════════════════════════════════ */

function createDom() {
  const state = {
    html: '',
    elements: new Map(),      // id → element（仅登记渲染出来过的 id）
    listeners: {},
    theme: 'light',
    alerts: [],
    confirms: [],
    confirmAnswer: true,
    hash: '#/overview',
  };

  function makeElement(id) {
    const el = {
      id: id || null,
      _innerHTML: '',
      value: '',
      files: null,
      checked: false,
      style: {},
      textContent: '',
      addEventListener(type, fn) { state.listeners[(id || '') + ':' + type] = fn; },
      removeEventListener() { /* noop */ },
      getAttribute(n) { return n === 'data-theme' ? state.theme : null; },
      setAttribute(n, v) { if (n === 'data-theme') state.theme = v; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      focus() { /* noop */ },
      click() { /* noop */ },
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._innerHTML; },
      set(v) {
        el._innerHTML = String(v);
        if (id === 'app') state.html = el._innerHTML;
        // 记录这次 HTML 里出现过的 id，让后续 $('#x') 能拿到元素
        for (const m of el._innerHTML.matchAll(/\bid="([^"]+)"/g)) {
          if (!state.elements.has(m[1])) state.elements.set(m[1], makeElement(m[1]));
        }
      },
    });
    return el;
  }

  const appEl = makeElement('app');

  function byId(id) {
    if (id === 'app') return appEl;
    if (state.elements.has(id)) return state.elements.get(id);
    // 未渲染出这个 id 就返回 null —— 与浏览器一致。
    // app.js 里普遍写成 `($('#x') || {}).value`，所以这是允许的；
    // 反过来，如果这里偷偷造一个元素出来，"没权限就不该出现"这类断言就永远为真了。
    return null;
  }

  const document = {
    documentElement: makeElement('html'),
    body: makeElement('body'),
    querySelector(sel) {
      if (sel === '#app') return appEl;
      if (sel.startsWith('#')) return byId(sel.slice(1));
      return null;                                  // 类选择器：前端未使用
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { state.listeners['document:' + type] = fn; },
    createElement() { return makeElement(null); },
    getElementById(id) { return byId(id); },
  };

  const win = {
    addEventListener(type, fn) { state.listeners['window:' + type] = fn; },
    removeEventListener() { /* noop */ },
    matchMedia: () => ({ matches: false }),
    confirm(msg) { state.confirms.push(msg); return state.confirmAnswer; },
    alert(msg) { state.alerts.push(msg); },
    prompt: () => null,
    location: {
      get hash() { return state.hash; },
      set hash(v) { state.hash = v; },
      protocol: 'http:',
      href: 'http://127.0.0.1:3090/',
    },
  };

  const localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };

  // ⚠️ 刻意**不**提供 sessionStorage：前端从 0.21.4 起一处都不用它了
  // （唯一用过它的是"内核引导本次会话已关掉"那个可关闭弹窗，那个弹窗已删除 ——
  //  未接入内核现在是**整页阻断**，没有"关掉"这个动作，也就没有"记住关过"这回事）。
  // 沙箱里不放它，是为了让"哪天又冒出一个没声明的全局"当场炸掉，而不是静默 undefined。
  return { state, document, window: win, localStorage, appEl, byId };
}

/** 假 fetch：按 `METHOD /path`（去掉 query）查表，返回录制到的真实响应。
 *  `onCall(opts, url)` 的第二个参数是**原始地址（带 query）**：查表键按设计去掉 query，
 *  但有的用例要断言"请求到底带了哪个 query"（如导出的 format=md/json）—— 就从这里拿。 */
function makeFetch(table, log) {
  return async function fetchStub(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const key = method + ' ' + String(url).split('?')[0];
    log.push(key);
    const entry = table[key];
    if (!entry) {
      return {
        ok: false, status: 404, headers: new Headers(),
        json: async () => ({
          ok: false,
          error: { code: 'not_recorded', message: '这条路径没有被录制：' + key },
        }),
      };
    }
    if (entry.onCall) entry.onCall(opts, String(url));
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      headers: new Headers(),
      json: async () => entry.body,
      // 非 JSON 响应（工作台的 NDJSON 流就靠它）：entry.text 优先，否则退化为 body 的 JSON 串。
      // 没有这个方法的话，任何"读纯文本响应体"的前端代码都会在回归里 TypeError。
      text: async () => (entry.text !== undefined ? entry.text : JSON.stringify(entry.body)),
      // 二进制响应（会话日志 log.zip）：录制侧用 saveRaw 存了真字节的 base64，这里还原成 Blob。
      // 没有它，前端 `await r.blob()` 就是 TypeError —— 下载功能在回归里根本跑不到真路径。
      blob: async () => new Blob([entry._b64
        ? Buffer.from(entry._b64, 'base64')
        : (entry.text !== undefined ? entry.text : JSON.stringify(entry.body))]),
    };
  };
}

/** 等前端那条异步链收敛：fetch 调用数连续若干轮不变就算静了。 */
async function settle(calls, { maxTicks = 600, quietTicks = 6 } = {}) {
  let last = -1;
  let quiet = 0;
  for (let i = 0; i < maxTicks; i++) {
    await new Promise((r) => setImmediate(r));
    if (calls.length === last) {
      if (++quiet >= quietTicks) return;
    } else {
      quiet = 0;
      last = calls.length;
    }
  }
  throw new Error('等待前端异步链收敛超时（fetch 调用数停在 ' + calls.length + '）');
}

/**
 * 驱动**应用内对话框**（0.15.0 起取代原生 prompt/confirm/alert）。
 *
 * 用法：先调用那个"会问一句"的动作（**不要 await**，它要等到有人答复才返回），
 * 再 `await answer(...)` 作答，最后 `await 那个动作的 promise`。
 *
 *   const p = sandbox.window.App.setUserDept(u.id);
 *   await answer(sandbox, dom, { pick: [1] });   // 选中第 2 个选项（0 是"不归属"）
 *   await p;
 *
 * ⚠️ 为什么必须走这条路：原生 prompt 在沙箱里只是一个"返回 null 的桩"，
 *    无论怎么改都测不出真实流程；而应用内对话框是**渲染出来的 HTML**，
 *    于是"弹层里写了什么、有哪些选项、按钮叫什么"全都成了可断言的事实。
 */
async function answer(sandbox, dom, opts = {}) {
  await new Promise((r) => setImmediate(r));   // 让 _open 里的 render 落地
  const opened = dom.state.html;               // 关闭前的快照 —— 弹层文案只能从这里断言
  assert.ok(/modal-wrap dlg/.test(opened),
    '应弹出应用内对话框；实际页面：' + opened.replace(/\s+/g, ' ').slice(0, 400));
  if (opts.value !== undefined) dom.byId('dlg-input').value = opts.value;
  for (const i of (opts.pick || [])) sandbox.window.App.dlgToggle(String(i));
  if (opts.cancel) sandbox.window.App.dlgCancel();
  else sandbox.window.App.dlgOk();
  await new Promise((r) => setImmediate(r));   // 让 close 里的 render 落地
  return opened;
}

/**
 * 驱动**由事件委托派发**的"会问一句"的动作（点按钮那条路）。
 * 与 answer 的区别：这里要先把 click 事件喂进 document 级委托。
 */
async function clickAndAnswer(dom, sandbox, attrs, opts = {}) {
  const click = dom.state.listeners['document:click'];
  click({ target: fakeEl(attrs), preventDefault() {} });
  return answer(sandbox, dom, opts);
}

/**
 * 在 vm 里执行真实的前端分片。
 *
 * ⚠️ **必须逐片执行，不能把 16 片拼成一个字符串跑**：每片开头的 `'use strict';` 只有在
 * **脚本顶部**才是指令；拼进一个大脚本后，第二片起的那句会退化成无意义的字符串表达式，
 * 后半段**静默脱离严格模式** —— 那等于回归跑的语义和浏览器不一样。分片跑才是真实形态。
 *
 * ⚠️ 各片是经典脚本，共享同一个全局作用域：`const`/`function` 声明在**全局词法环境**里，
 * 后面的片能直接看到前面的片（浏览器同理）。最后一片自己调用 `boot()`，所以**拿不到返回值**。
 * 早先这里写成 `globalThis.__bootPromise = boot()` —— 那是错的：`boot` 在闭包里，
 * 凭空多出一行反而让脚本自己抛 ReferenceError，8 个用例全挂。
 * 正确做法是等异步链自然静下来，并**收集未捕获的 rejection**（那个历史 bug 就是这个形态）。
 */
async function runApp({ needsSetup = false, permissions = null, loggedIn = false, overrides = null } = {}) {
  const parts = readAppParts();
  const dom = createDom();
  const calls = [];
  const session = { loggedIn };

  // 按用例改写三种"输入"，形状仍取自真实响应
  const table = Object.assign(Object.create(null), routes);
  table['GET /api/identity/setup'] = routes[needsSetup ? 'GET /api/identity/setup#fresh' : 'GET /api/identity/setup#ready'];
  table['GET /api/identity/me'] = {
    get status() { return session.loggedIn ? 200 : routes['GET /api/identity/me#anon'].status; },
    get body() {
      if (!session.loggedIn) return routes['GET /api/identity/me#anon'].body;
      const m = JSON.parse(JSON.stringify(meBody));
      if (permissions) m.permissions = permissions;
      return m;
    },
  };
  table['POST /api/identity/login'] = {
    status: 200,
    body: loginBody,
    onCall: () => { session.loggedIn = true; },
  };
  // overrides 必须放在三个身份桩**之后**：它是"按用例改写任一响应"的出口，
  // 两步登录的用例正是靠它换掉 login（回票据而不是直接登入）与 me（按阶段给 401/200）。
  // 早先放在桩前 → 这三键永远被桩覆盖，MFA 流程根本驱动不起来。
  for (const [k, v] of Object.entries(overrides || {})) table[k] = v;

  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    fetch: makeFetch(table, calls),
    // 浏览器 URL 才有 createObjectURL（Node 原生 URL 没有）——导出下载用到
    URL: Object.assign(class extends URL {}, {
      createObjectURL: () => 'blob:stub-' + Math.random().toString(36).slice(2),
      revokeObjectURL: () => {},
    }),
    Blob,
    URLSearchParams,
    TextDecoder, TextEncoder,
    // 浏览器标准 API，vm 的沙箱不会自带 —— 工作台用它来"停止"正在接收的流。
    AbortController,
    // ⚠️ 0.21.9：`wbPaint` 的"滚到底"改成了 `requestAnimationFrame(stick)`。
    //    不给这个垫片，沙箱里 `typeof requestAnimationFrame !== 'function'`，
    //    代码会走"极老环境"的同步回退分支 —— 于是**修复后的那条路径在回归里
    //    根本测不到**（测试照样全绿，真机照样坏）。这里用 setTimeout(…, 0) 实现：
    //    它就是"下一个宏任务"，语义上等价于"浏览器重排之后"，
    //    而且能跟 `settle()` 的调用队列一起被驱动。
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    location: dom.window.location,
    localStorage: dom.localStorage,
    document: dom.document,
    alert: (m) => dom.window.alert(m),
    confirm: (m) => dom.window.confirm(m),
    prompt: () => null,
    Headers,
    FileReader: class {
      readAsDataURL(file) {
        this.result = 'data:' + (file.type || 'application/octet-stream') + ';base64,' + (file._b64 || '');
        if (this.onload) this.onload();
      }
    },
  };
  sandbox.window = dom.window;
  sandbox.globalThis = sandbox;
  dom.window.document = dom.document;
  dom.window.localStorage = dom.localStorage;

  const context = vm.createContext(sandbox);
  // ⚠️ 0.21.9：把 context 本身挂回 sandbox（非枚举）—— 只为 `runInApp` 用。
  // 为什么必须留这个口子：前端分片的顶层 `const`（`State`）与顶层 `function`（`render`）
  // 是**词法声明**，不会成为 sandbox 的属性，Node 侧够不着（详见 `runInApp` 的说明）。
  // 用 defineProperty + enumerable:false，免得任何 `Object.keys(sandbox)` /
  // 序列化断言把这个内部句柄当成一个"全局变量"看见。
  Object.defineProperty(sandbox, '__ctx', { value: context, enumerable: false });
  try {
    for (const [file, code] of parts) {
      const script = new vm.Script(code, { filename: 'public/app/' + file });
      script.runInContext(context, { timeout: 10000 });
    }
    await settle(calls);
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }

  return { dom, sandbox, calls, session, rejections, table };
}

/* ── 1. 静态一致性（不需要执行 app.js） ─────────────────────────── */

section('静态一致性');

/** 去掉注释：`App.xxx(` 也出现在文档注释里，不剥掉会得到假阳性。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

await t('index.html 引用的每个资源都存在、分片顺序可解析，且不含内联 <script>', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  assert.ok(/src=["']\.\/boot\.js["']/.test(html), 'index.html 应引用 boot.js（首屏脚本已外链）');
  assert.ok(/href=["']\.\/style\.css["']/.test(html), 'index.html 应引用 style.css');
  // 前端是多片：**逐个引用**都必须在磁盘上真的存在（漏拷一片 = 白屏，而且只报 404 不报错）
  const refs = [...new Set([...html.matchAll(/(?:src|href)=["']\.\/([^"']+)["']/g)].map((m) => m[1]))];
  assert.ok(refs.length >= 10, 'index.html 应引用多个前端资源，实际 ' + refs.length + ' 个');
  for (const r of refs) {
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, r)), 'index.html 引用了不存在的资源：' + r);
  }
  assert.ok(APP_FILES.length >= 10, '应加载多个前端分片，实际 ' + APP_FILES.length + ' 片');
  // 分片顺序必须与文件名的数字前缀顺序一致 —— 否则 index.html 里的先后与"依赖顺序"脱钩，
  // 后面某天挪一行就会变成"某个 const 还没声明就被引用"，而这种错只在浏览器里炸。
  assert.deepEqual(APP_FILES, [...APP_FILES].sort(), 'index.html 的分片顺序应与文件名的数字前缀升序一致');
  // 3.4 的核心保证：CSP 的 script-src 已不含 'unsafe-inline'，
  // 因此 index.html 里**不能**再有内联 <script>…</script>（浏览器会拒绝执行它）。
  // 先剥掉 HTML 注释：注释里出现 "<script" 这类字样不该被当成真的内联脚本。
  const bare = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(bare),
    'index.html 不得再有内联 <script>（会被 CSP 拒绝执行）');
});

await t('前端不得再有内联事件属性 / javascript: URI（CSP 去 unsafe-inline 的前提）', () => {
  const files = [
    ...readAppParts(),
    ['boot.js', fs.readFileSync(path.join(PUBLIC_DIR, 'boot.js'), 'utf8')],
    ['index.html', fs.readFileSync(INDEX_HTML, 'utf8')],
  ];
  for (const [name, raw] of files) {
    const src = stripComments(raw);
    // 只认"内联 HTML 事件属性"形态：on<事件>= 后面紧跟引号（属性值）。
    // 不能只写 `onload=`，否则会误伤 `fr.onload = () => {}` 这种 JS 属性赋值。
    const hits = [...src.matchAll(/\bon(?:click|change|input|submit|load|error|keydown|keyup|focus|blur)\s*=\s*["']/g)]
      .map((m) => m[0].replace(/\s*=\s*["']/, '='));
    assert.deepEqual(hits, [], name + ' 仍有内联事件属性：' + hits.join(', '));
    assert.ok(!/javascript:/i.test(src), name + ' 仍有 javascript: URI（同样被 script-src 拦）');
  }
});

await t('护栏：内联 style="..." 属性不得再增长（style-src 保留 unsafe-inline 的前提）', () => {
  // style-src 的 'unsafe-inline' 是**明知的取舍**（理由见 app/http/security-headers.mjs 与
  // architecture.md §7.6）。取舍能成立的前提是"数量被盯着" —— 所以这里把**当前计数冻成断言**：
  // 新增一处内联样式就必须改这个数字，而"改基线"这件事本身会被看见。
  // ⚠️ 基线从 122 → 123 的经过：3.6 加附件条时，`＋附件` 的隐藏 `<input type="file">` 带了
  //    `style="display:none"`，**当时没人发现** —— 这正是"只在文档里写个数字、不加护栏"的后果。
  // ⚠️ 基线从 123 → 120 的经过：0.15.2 重写契约与映射页时，顺手把该页 3 处
  //    `style="margin-top:12px"` 改成了无内联样式的写法（间距职责交给相邻选择器/组件自带边距）。
  // ⚠️ 基线从 120 → 119 的经过：0.15.7 移除概览页「尚未交付的能力」面板（开发过程叙事
  //    退出产品 UI），随之消失 1 处 `style="margin-top:10px"`。只减不增，护栏语义不变。
  // ⚠️ 基线从 138 → 134 的经过：0.16.2 删除「平台主动发起工具执行」功能族，审批页/待审批面板/
  //    工具策略表整体下线，随之消失 4 处内联样式（审批单状态徽标、策略表行内输入等）。
  //    只减不增，护栏语义不变。
  // ⚠️ 基线从 134 → 130 的经过：删除「会话与回合」页（日常对话与管理已全在对话工作台），
  // 130 → 129：0.21.0 工作区树重写侧栏，顺手把旧"还没有会话"空态上唯一的内联
  // style 换成了 class（.wb-ws-empty）—— 有意减一，见 architecture.md §7.6。
  //    随之消失 4 处内联样式（面板间距、选中行高亮、提交区与事件区间距）。
  //    只减不增，护栏语义不变。
  // ⚠️ 基线从 129 → 126 的经过：0.21.10 来源页收尾，把导入粘贴区的
  //    `style="width:100%;font-family:monospace"` 与它下面那行的
  //    `style="margin-top:8px"` 两处**纯布局内联样式**换成 class（`.import-box` / `.mt-8`）。
  //    ⚠️ **只减不增的数要真的量过再写**：这次差点写成 127（"减二"口算 129-2），
  //    按测试的原式量出来是 **126** —— 说明基线 129 与当时的真实计数之间本来就差 1
  //    （历史上某次改动只改了数字没改计数，或是这中间有别的分片增减没同步记）。
  //    这是本护栏**自身的**教训：它的意义全在"数字是真的"，口算出来的数字和
  //    "只在文档里写个数字"没有区别。以后改这个值一律先量。
  //    顺带说明为什么这两处值得顺手改：它们不是"需要内联才能表达"的东西，只是当初没建类。
  const INLINE_STYLE_BASELINE = 126;
  const counts = {};
  let total = 0;
  // 分片后按**片**计数（而不是只算一个 app.js）—— 这样"哪一片新增了内联样式"直接看得见
  for (const [f, src0] of [...readAppParts(), ['boot.js', fs.readFileSync(path.join(PUBLIC_DIR, 'boot.js'), 'utf8')], ['index.html', fs.readFileSync(INDEX_HTML, 'utf8')]]) {
    const src = stripComments(src0);
    counts[f] = (src.match(/\bstyle\s*=\s*["']/g) || []).length;
    total += counts[f];
  }
  assert.equal(total, INLINE_STYLE_BASELINE,
    '内联 style 属性数变了（当前 ' + total + '，冻结基线 ' + INLINE_STYLE_BASELINE + '）；'
    + '有意新增请同步改基线并在 architecture.md §7.6 记录，无意新增请改用 class。明细 ' + JSON.stringify(counts));
  assert.equal(counts['index.html'], 0, 'index.html 里不该有内联 style 属性（应全在 style.css）');
});

await t('操作反馈（notice / error）是**纯文本**：文案里不得内嵌 HTML 标签（渲染时会整体转义成字面量）', () => {
  // 这是真机抓到的：某条成功提示里写了 `<b>还没有任何角色</b>`，而渲染处是
  // `esc(State.notice)` —— 于是用户在页面上看到的**就是** `<b>还没有任何角色</b>` 这串字符。
  // 反馈条永远按纯文本转义（这是对的，文案里可能带用户输入），所以文案自己必须守规矩。
  const offenders = [];
  for (const [f, src0] of readAppParts()) {
    const src = stripComments(src0);
    for (const m of src.matchAll(/State\.(?:notice|error)\s*(?:=|\+=)\s*([^\n]+)/g)) {
      for (const s of m[1].match(/'[^']*'|"[^"]*"/g) || []) {
        if (/<\/?[a-zA-Z][^>]*>/.test(s)) offenders.push(f + '：' + m[1].trim().slice(0, 90));
      }
    }
  }
  assert.deepEqual(offenders, [],
    '反馈文案里出现了 HTML 标签（会被转义成字面文本亮给用户）：\n  ' + offenders.join('\n  '));
});

await t('onclick="App.x()" / App.x() 里用到的每个方法都真的定义在 App 对象上', () => {
  // App 对象现在由**多片合成**：`70-app.js` 定义本体，`71-app-workbench.js` 用
  // `Object.assign(App, {...})` 把工作台域（25 个 `wb*` 方法）归并回**同一个**对象
  // —— 拆文件，但**不换命名空间**（`40-delegate.js` 按 `App.<action>` 取函数）。
  // 所以这里必须把"所有往 App 上挂成员的块"都解析进来：只认 `const App = {`
  // 会让搬走的方法全被判成"未定义"。**这条用例就是被拆分改红的** —— 它确实在工作。
  const blocks = [];
  for (const [f, raw] of readAppParts()) {
    const src = stripComments(raw);
    const start = src.indexOf('const App = {');
    if (start >= 0) {
      // App 对象在**顶层**，结尾是列 0 的 `};`（拆分前它包在 IIFE 里，是缩进 2 空格）。
      const end = src.indexOf('\n};', start);
      assert.ok(end > start, f + '：`const App = {` 找不到结尾 `\n};`');
      blocks.push([f, src.slice(start, end)]);
    }
    for (const m of src.matchAll(/Object\.assign\(App\s*,\s*\{/g)) {
      const from = m.index + m[0].length;
      const end = src.indexOf('\n});', from);
      assert.ok(end > from, f + '：`Object.assign(App, {` 找不到结尾 `\n});`');
      blocks.push([f, src.slice(from, end)]);
    }
  }
  assert.ok(blocks.length >= 2,
    'App 的成员应来自多个块（本体 + 至少一个按域归并的片），实际 ' + blocks.length);

  const declared = new Set();
  for (const [, body] of blocks) {
    // 成员缩进是 2 空格（App 在顶层；含 `Object.assign` 块内的成员）
    for (const m of body.matchAll(/^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) declared.add(m[1]);  // method() {}
    for (const m of body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)) declared.add(m[1]);              // key: value
    for (const m of body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*,\s*$/gm)) declared.add(m[1]);          // 简写属性 key,
  }
  assert.ok(declared.size > 20, '解析出的 App 方法太少（' + declared.size + '），说明解析逻辑失效了');

  const used = new Set();
  const allSrc = stripComments(readAppSource());     // 调用点可能在任何一片里
  for (const m of allSrc.matchAll(/\bApp\.([A-Za-z_$][\w$]*)\s*\(/g)) used.add(m[1]);
  // 内联 onclick 已改成事件委托：`act('名字')` / `actCh('名字')` 里的名字同样必须真的定义在 App 上
  // （否则点了没反应 —— 这正是事件委托最容易出的错，必须被回归钉住）。
  for (const m of allSrc.matchAll(/\bact(?:Ch)?\(\s*'([A-Za-z_$][\w$]*)'/g)) used.add(m[1]);
  used.delete('prototype');
  assert.ok(used.size > 20, '解析出的 App 调用太少（' + used.size + '）');

  const missing = [...used].filter((x) => !declared.has(x)).sort();
  assert.deepEqual(missing, [], '这些 App 方法被调用但没有定义：' + missing.join(', '));
});

await t('前端没有裸调用只定义在 App 上的加载函数（历史 bug 的形态）', () => {
  const src = stripComments(readAppSource());
  const appMethods = ['loadStatus', 'loadRoutes', 'loadContract', 'loadMiddleware',
    'loadUsers', 'loadRoles', 'loadCreds', 'loadApiKeys', 'loadKnowledge'];
  for (const name of appMethods) {
    // 允许 `App.name(`；不允许裸调用。注意要放过**方法定义行**本身
    // （`async loadStatus() {` —— 它也是"没有 App. 前缀"的，早先这里误报过）。
    const re = new RegExp('(?<!App\\.)(?<![\\w$])' + name + '\\s*\\(', 'g');
    for (const m of src.matchAll(re)) {
      const from = src.lastIndexOf('\n', m.index) + 1;
      const to = src.indexOf('\n', m.index);
      const line = src.slice(from, to === -1 ? src.length : to);
      const isDefinition = /^\s*(?:async\s+)?(?:function\s+)?[\w$]+\s*\([^()]*\)\s*\{\s*$/.test(line);
      assert.ok(isDefinition,
        '出现了裸调用 ' + name + '()（应写成 App.' + name + '()），在：' + line.trim());
    }
  }
});

/* ── 2. 真实执行：启动与初始化 ─────────────────────────────────── */

section('真实执行：启动与初始化');

await t('全新机器：首次加载进入初始化向导，且不抛异常', async () => {
  const { dom, rejections } = await runApp({ needsSetup: true });
  assert.deepEqual(rejections.map((e) => String((e && e.message) || e)), [], 'boot 抛出了未捕获的异常');
  assert.ok(/初始化 STI HARNESS/.test(dom.state.html), '应渲染初始化向导，实际：' + dom.state.html.slice(0, 200));
  assert.ok(dom.byId('adminPassword'), '初始化向导应有管理员口令输入框');
});

await t('已初始化 + 未登录：停在登录页（401 是真实响应，不是桩造的）', async () => {
  const { dom, calls, rejections } = await runApp({ needsSetup: false });
  assert.deepEqual(rejections.map((e) => String((e && e.message) || e)), [], 'boot 抛出了未捕获的异常');
  assert.ok(calls.includes('GET /api/identity/setup'), '应首先读取初始化状态');
  assert.ok(calls.includes('GET /api/identity/me'), '应尝试读取当前身份');
  assert.ok(/<h1>登录<\/h1>/.test(dom.state.html), '应渲染登录页，实际：' + dom.state.html.slice(0, 200));
  assert.ok(dom.byId('loginUser') && dom.byId('loginPass'), '登录页应有账号与口令输入框');
});

/* ── 3. 登录后加载全部页面 ─────────────────────────────────────── */

section('真实执行：登录后加载全部页面（这里曾抛 ReferenceError）');

await t('登录成功后 loadAll() 跑通，页面出现知识库入口且没有任何未定义引用', async () => {
  const { dom, sandbox, calls, rejections } = await runApp({ needsSetup: false, permissions: meBody.permissions });
  assert.ok(sandbox.window.App, 'window.App 应已挂上');

  await sandbox.window.App.login();
  await settle(calls);

  assert.deepEqual(rejections.map((e) => String((e && e.message) || e)), [], '登录流程抛出了未捕获的异常');

  const html = dom.state.html;
  // 当年那个 bug 的表现：`loadStatus is not defined` 被 boot 的 catch 抓住 → 页面回登录页
  //                                   并显示"无法读取当前身份：loadStatus is not defined"
  assert.ok(!/is not defined/.test(html), '页面出现未定义引用，实际片段：' + html.slice(0, 400));
  assert.ok(!/ReferenceError/.test(html), '页面出现 ReferenceError');
  assert.ok(!/<h1>登录<\/h1>/.test(html), '登录成功后不应还停在登录页（说明 loadAll 抛错被 catch 了）');
  assert.ok(/知识库与检索/.test(html), '侧栏应有知识库入口');
  for (const ep of ['/api/knowledge/status', '/api/knowledge/bases', '/api/system/status']) {
    assert.ok(calls.some((c) => c.includes(ep)), '登录后应请求 ' + ep);
  }
  const docCall = calls.find((c) => c.includes('/documents'));
  assert.ok(docCall, 'loadKnowledge 应接着拉文档列表');
});

/* ── 3b. 事件委托（P1-3 / 3.4 去 unsafe-inline 的核心机制）────────── */

section('真实执行：事件委托（data-act → App 方法）');

/** 造一个"够用的假元素"：委托只用到 getAttribute 与向上找 parentNode。 */
function fakeEl(attrs, parent = null) {
  return {
    parentNode: parent,
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null; },
  };
}

await t('事件委托：data-act 派发到 App 方法，参数原样到达（含布尔还原 / 双参数 / 冒泡）', async () => {
  const ctx = await runApp({ loggedIn: true });
  const { dom, sandbox } = ctx;
  await sandbox.window.App.login();
  await settle(ctx.calls);

  // 渲染出的 HTML 里必须真有 data-act；且不得再出现任何内联事件属性。
  assert.ok(/data-act="/.test(dom.state.html), '页面 HTML 里应出现 data-act 属性');
  assert.ok(!/\bon(?:click|change)\s*=/.test(dom.state.html), '页面 HTML 里不得再出现内联事件属性');

  const click = dom.state.listeners['document:click'];
  assert.equal(typeof click, 'function', '应注册 document 级 click 委托');

  // 探针：替换目标方法，只观察"委托把什么参数送到了方法上"，不触发真实请求。
  const seen = [];
  for (const name of ['setStatus', 'toggleSkill', 'delCred', 'runSetup', 'logout']) {
    sandbox.window.App[name] = (...a) => { seen.push([name, ...a]); };
  }

  let prevented = 0;
  const ev = (target) => ({ target, preventDefault() { prevented++; } });

  // 1) 双参数
  click(ev(fakeEl({ 'data-act': 'setStatus', 'data-a1': 'u1', 'data-a2': 'disabled' })));
  // 2) 双参数 + 布尔字面量还原
  click(ev(fakeEl({ 'data-act': 'toggleSkill', 'data-a1': 'skill-x', 'data-a2': 'false' })));
  // 3) 真正的双字符串参数（值里带中文，确认没被二次转义）
  click(ev(fakeEl({ 'data-act': 'delCred', 'data-a1': 'cred-1', 'data-a2': '生产库口令' })));
  // 4) 无参
  click(ev(fakeEl({ 'data-act': 'runSetup' })));
  // 5) 冒泡：点在子节点上，祖先才带 data-act
  click(ev(fakeEl({}, fakeEl({ 'data-act': 'logout' }))));

  assert.deepEqual(seen, [
    ['setStatus', 'u1', 'disabled'],
    ['toggleSkill', 'skill-x', false],       // 布尔还原：不是字符串 "false"
    ['delCred', 'cred-1', '生产库口令'],
    ['runSetup', undefined, undefined],       // 无参：两个都是 undefined
    ['logout', undefined, undefined],         // 冒泡到祖先也算命中
  ]);
  assert.equal(prevented, 5, '每次命中都要 preventDefault（否则 <a href="#"> 会跳锚点）');

  // 名字写错：不得抛，也不得误触发任何方法
  const n = seen.length;
  click(ev(fakeEl({ 'data-act': 'thisMethodDoesNotExist' })));
  assert.equal(seen.length, n, '未知 data-act 不应触发任何方法');
});

await t('事件委托：data-nav 改 hash（导航项不再靠内联 onclick 改 location）', async () => {
  const ctx = await runApp({ loggedIn: true });
  const { dom, sandbox } = ctx;
  await sandbox.window.App.login();
  await settle(ctx.calls);

  assert.ok(/data-nav="#\//.test(dom.state.html), '侧栏导航项应带 data-nav');

  const click = dom.state.listeners['document:click'];
  const before = ctx.dom.state.hash;
  click({ target: fakeEl({ 'data-nav': '#/users' }), preventDefault() {} });
  assert.equal(ctx.dom.state.hash, '#/users', '点击导航项应把 hash 改到目标路由（原先：' + before + '）');
});

await t('事件委托：data-change 把元素当前值传给 App（select 的 onchange 已外提）', async () => {
  const ctx = await runApp({ loggedIn: true });
  const { dom, sandbox } = ctx;
  await sandbox.window.App.login();
  await settle(ctx.calls);

  const change = dom.state.listeners['document:change'];
  assert.equal(typeof change, 'function', '应注册 document 级 change 委托');

  const got = [];
  sandbox.window.App.switchModelKind = (v) => { got.push(v); };

  const el = fakeEl({ 'data-change': 'switchModelKind' });
  el.value = 'embedding';
  change({ target: el });
  assert.deepEqual(got, ['embedding'], 'change 委托应把元素当前值传入');
});

/* ── 4. 知识库页与检索 ─────────────────────────────────────────── */

section('真实执行：知识库页面与检索');


async function openKnowledge(opts = {}) {
  const ctx = await runApp({ needsSetup: false, permissions: meBody.permissions, ...opts });
  await ctx.sandbox.window.App.login();
  await settle(ctx.calls);
  ctx.dom.window.location.hash = '#/knowledge';
  const h = ctx.dom.state.listeners['window:hashchange'];
  assert.ok(h, '应注册 hashchange 监听');
  h();
  return ctx;
}

await t('进入知识库页：显示检索模式、实测解析能力与知识库列表', async () => {
  const { dom } = await openKnowledge();
  const html = dom.state.html;
  assert.ok(/当前检索模式/.test(html), '应有检索模式面板');
  assert.ok(/纯文本检索/.test(html), 'embedding=none 时应明确显示纯文本检索（不谎称混合检索）');
  assert.ok(/解析能力（实测，不是"应该支持"）/.test(html), '应展示实测解析能力');
  assert.ok(/PDF 不可用|PDF 可用/.test(html), 'PDF 支持情况要如实显示');
  assert.ok(/Office 不可用|Office 可用/.test(html), 'Office 支持情况要如实显示');
  assert.ok(/企业制度库/.test(html), '应列出刚建的知识库');
  assert.ok(/权限管理规范/.test(html), '应列出已导入的文档');
  assert.ok(/解析失败/.test(html), '解析失败的文档要显示失败状态');
  assert.ok(/年度报告\.pdf/.test(html), '失败文档也要出现在列表里');
  assert.ok(/pdftotext|PDF/.test(html), '失败原因必须能看出缺什么');
  assert.ok(/导入与建库需要 knowledge:write/.test(html), '有写权限时应显示提权说明');
});

await t('分块预览：每个分块都带可回溯的引用标签，且如实标注向量有无', async () => {
  const { dom, sandbox, calls } = await openKnowledge();
  await sandbox.window.App.previewChunks(DOC_ID);
  await settle(calls);
  const html = dom.state.html;
  const dump = '；分块面板：' + html.replace(/\s+/g, ' ').slice(html.indexOf('分块预览'), html.indexOf('分块预览') + 900);
  assert.ok(/分块预览/.test(html), '应进入分块预览' + dump);
  assert.ok(/权限管理规范/.test(html), '预览标题应是文档标题' + dump);
  assert.ok(/引用能不能回溯/.test(html), '应说明定位信息的用途' + dump);
  assert.ok(/›/.test(html), '分块应带可回溯的引用标签（文档 › 章节）' + dump);
  assert.ok(!/无定位信息/.test(html),
    '这份内容有标题层级，分块不该被标成"无定位信息"（说明标题没被识别）' + dump);
  assert.ok(/有向量|无向量/.test(html), '应如实标注每个分块有没有向量' + dump);
});

await t('执行检索：结果带引用标签、rrf 分与两条路径排名', async () => {
  const { dom, sandbox, calls } = await openKnowledge();
  const q = dom.byId('kb-q');
  assert.ok(q, '检索输入框应已渲染');
  const lim = dom.byId('kb-limit');
  assert.ok(lim, '条数输入框应已渲染');
  lim.value = '10';
  q.value = '权限管理';
  await sandbox.window.App.runSearch();
  await settle(calls);

  const html = dom.state.html;
  const dump = () => {
    const flat = html.replace(/\s+/g, ' ');
    const at = flat.indexOf('召回测试');
    const err = flat.match(/<div class="note fail">[^<]{0,300}/);
    return ('；错误提示：' + (err ? err[0] : '（无）'))
      + '；检索面板：' + flat.slice(at >= 0 ? at : -900);
  };
  assert.ok(/权限管理规范/.test(html), '应显示命中文档' + dump());
  assert.ok(/›/.test(html), '引用标签应含层级分隔符（文档 › 章节）' + dump());
  assert.ok(/rrf/.test(html), '应显示 rrf 分与两条路径的排名' + dump());
  assert.ok(/文本排名 \d/.test(html), '应显示文本路径排名' + dump());
  assert.ok(/向量排名 —/.test(html), '无向量时应显示为 —，而不是造假数字' + dump());
  assert.ok(/纯文本模式|纯文本/.test(html), '应显示降级说明' + dump());
  assert.ok(!/undefined/.test(html), '结果里不应出现 undefined' + dump());
});

await t('预过滤三态开关：跟随配置时不带该字段，强制开/关才显式覆盖', async () => {
  // 这个开关的价值全在"真的发出去了"—— 只断言页面有下拉框，等于没测。
  // 所以这里截请求体，逐个验证三态的 JSON 形状。
  const seen = [];
  const base = routes['POST /api/knowledge/search'];
  const { dom, sandbox, calls } = await openKnowledge({
    overrides: {
      'POST /api/knowledge/search': {
        ...base,
        onCall: (opts) => { try { seen.push(JSON.parse(opts.body || '{}')); } catch { seen.push(null); } },
      },
    },
  });
  assert.ok(/预过滤：跟随配置/.test(dom.state.html), '三态文案必须齐全（跟随配置）');
  assert.ok(/预过滤：强制开/.test(dom.state.html), '必须能强制开');
  assert.ok(/预过滤：强制关/.test(dom.state.html),
    '必须能强制关 —— 否则"我知道代价、我就要召回无损"这件事在界面上没法表达');

  const search = async (pfVal) => {
    dom.byId('kb-q').value = '权限管理';
    const pf = dom.byId('kb-prefilter');
    assert.ok(pf, '预过滤三态开关必须渲染出来（否则这个配置在界面上没有入口）');
    pf.value = pfVal;
    await sandbox.window.App.runSearch();
    await settle(calls);
    return seen[seen.length - 1];
  };

  const follow = await search('');
  assert.ok(follow && !('prefilter' in follow),
    '跟随配置时**不许**把 prefilter 塞进请求体（undefined 不该被写成 null/false，否则服务端会以为是显式覆盖）');

  assert.equal((await search('on')).prefilter, true, '强制开必须显式传 true');
  assert.equal((await search('off')).prefilter, false, '强制关必须显式传 false');
  assert.ok(/预过滤/.test(dom.state.html), '结果面板必须显示预过滤的实际状态（关/生效/退化要能分辨）');
});

await t('换序查询：走宽松档命中，并在页面上写明用了哪一档', async () => {
  // 这一次让服务端返回"换序查询"的真实响应（录制时单独存了一份，没覆盖正式键）
  const { dom, sandbox, calls } = await openKnowledge({
    overrides: { 'POST /api/knowledge/search': routes['POST /api/knowledge/search#reordered'] },
  });
  dom.byId('kb-q').value = '管理权限';
  await sandbox.window.App.runSearch();
  await settle(calls);
  const html = dom.state.html;
  assert.ok(/文本档/.test(html), '应显示实际用了哪一档文本匹配');
  assert.ok(/依次尝试/.test(html), '应显示尝试过的匹配档位序列');
  assert.ok(!/没有命中/.test(html), '换序查询不应 0 命中（bigram 用 AND 时会踩这个坑）');
});

await t('导入文本：成功后给出可读结论，并刷新文档列表', async () => {
  const { dom, sandbox, calls } = await openKnowledge();
  const ta = dom.byId('kb-text');
  const titleEl = dom.byId('kb-doc-title');
  assert.ok(ta, '导入文本框应已渲染（管理员才有）');
  assert.ok(titleEl, '标题输入框应已渲染');

  ta.value = '数据治理要求：所有地理信息数据必须登记空间参考系与精度说明。';
  titleEl.value = '数据治理备忘';

  const before = calls.filter((c) => c === 'POST /api/knowledge/documents').length;
  await sandbox.window.App.importText();
  await settle(calls);
  const after = calls.filter((c) => c === 'POST /api/knowledge/documents').length;
  assert.equal(after, before + 1, '应发起一次导入请求');

  const html = dom.state.html;
  const dump = '；页面提示：' + html.replace(/\s+/g, ' ').slice(0, 700);
  assert.ok(/已导入/.test(html), '应显示导入结论' + dump);
  assert.ok(/解析器 markdown/.test(html), '结论里应写明用了哪个解析器（粘贴的 Markdown 应被识别）' + dump);
  assert.ok(/识别为 Markdown/.test(html), '自动判定要在结论里说明，不能悄悄改行为' + dump);
  assert.ok(/个分块/.test(html), '结论里应写明分块数' + dump);
  assert.ok(calls.filter((c) => c.includes('/documents')).length >= 2, '导入后应重新拉文档列表');
});

await t('无写权限的角色：不渲染导入区，也不渲染删除入口', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  perms.knowledge.write = false;
  perms.knowledge.delete = false;
  const { dom } = await openKnowledge({ permissions: perms });
  const html = dom.state.html;
  assert.ok(/企业制度库/.test(html), '只读用户仍应看到知识库列表');
  assert.ok(dom.byId('kb-text') === null, '只读用户不应看到导入文本框');
  assert.ok(dom.byId('kb-name') === null, '只读用户不应看到新建知识库输入框');
  assert.ok(!/data-act="deleteDocument"/.test(html), '只读用户不应看到删除文档入口');
  assert.ok(!/data-act="renameDocument"/.test(html), '只读用户不应看到文档改名入口（写动作，与删除同门）');
  assert.ok(!/data-act="deleteBase"/.test(html), '只读用户不应看到删除知识库入口');
  assert.ok(!/导入与建库需要 knowledge:write/.test(html), '既然不给导入，就不该提示"导入需要什么权限"');
  assert.ok(/data-act="runSearch"/.test(html), '只读用户仍应能检索');
  // §B9：授权面板**刻意不按租户级 knowledge:write 关闭**。判定口径在服务端、按**该库**算，
  // 而前端的 `allowed()` 只看得到全局角色 —— 若在这里关掉，"全局是 viewer、本库被授成 admin"
  // 的库级管理员（这个面板唯一真正的服务对象）就永远看不到它。
  // 正确的兜底是"照样渲染、把服务端的拒绝原样呈现"，见下面 §B9 的 403 用例。
  assert.ok(dom.byId('grant-subject') !== null,
    '没有租户级 knowledge:write 的账号仍应看到授权表单（他可能正是这个库的库级管理员）');
});

/* ── 文档维护入口：改名（E2，0.18.0）────────────────────────────────── */

await t('文档改名：弹层预填当前标题；取消不发请求；确认后 PATCH 请求体是 trim 后的新名', async () => {
  const patchKey = 'PATCH /api/knowledge/documents/' + DOC_ID;
  const listKey = 'GET /api/knowledge/bases/' + KB_ID + '/documents';
  const seen = [];
  const { dom, sandbox, calls } = await openKnowledge({
    overrides: {
      [patchKey]: Object.assign({}, routes[patchKey], {
        onCall: (opts) => { try { seen.push(JSON.parse(opts.body || '{}')); } catch { seen.push(null); } },
      }),
    },
  });
  await settle(calls);

  const html0 = dom.state.html;
  assert.ok(html0.includes('data-act="renameDocument" data-a1="' + DOC_ID + '" data-a2="权限管理规范"'),
    '文档行应有改名入口，且把当前标题带给弹层（要在原名上改，而不是从零重打）');

  // 取消路径：弹层预填当前标题；取消后一个请求都不许发
  const n0 = calls.filter((c) => c === patchKey).length;
  const opened = await clickAndAnswer(dom, sandbox,
    { 'data-act': 'renameDocument', 'data-a1': DOC_ID, 'data-a2': '权限管理规范' }, { cancel: true });
  assert.ok(/重命名文档/.test(opened), '弹层标题应写明「重命名文档」，实际：' + opened.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(/id="dlg-input"[^>]*value="权限管理规范"/.test(opened),
    '输入框应预填当前标题，实际：' + opened.replace(/\s+/g, ' ').slice(-400));
  await settle(calls);
  assert.equal(calls.filter((c) => c === patchKey).length, n0, '取消后不应发改名请求');

  // 确认路径：带前后空格提交 —— 请求体必须是 trim 后的（与服务端口径一致）
  const n1 = calls.filter((c) => c === listKey).length;
  await clickAndAnswer(dom, sandbox,
    { 'data-act': 'renameDocument', 'data-a1': DOC_ID, 'data-a2': '权限管理规范' },
    { value: '  权限管理规范（改后） ' });
  await settle(calls);
  assert.deepEqual(seen, [{ title: '权限管理规范（改后）' }], '请求体必须只含 trim 后的 title');
  const html = dom.state.html;
  assert.ok(/已改名/.test(html), '要有可见回执，实际：' + html.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(html.includes('权限管理规范（改后）'), '回执应带服务端存下的新标题');
  assert.ok(!/modal-wrap dlg/.test(html), '确认后弹层应关闭');
  assert.ok(calls.filter((c) => c === listKey).length > n1, '改名后应重新拉文档列表');
  // 回放不重建状态：重拉拿到的仍是录制快照（旧标题）—— 这是回放的边界，不是缺陷；
  // 本用例的断言对象是请求体与回执（上面两条），不是回放快照的内容。
});

await t('文档改名 · 长名前端先拦：超过 300 字留在弹层里说清原因，不发请求（与服务端同口径）', async () => {
  const patchKey = 'PATCH /api/knowledge/documents/' + DOC_ID;
  const { dom, sandbox, calls } = await openKnowledge();
  await settle(calls);
  const n0 = calls.filter((c) => c === patchKey).length;

  const p = sandbox.window.App.renameDocument(DOC_ID, '权限管理规范');   // 不 await：等答复才返回
  await new Promise((r) => setImmediate(r));                              // 让弹层渲染落地
  assert.ok(/modal-wrap dlg/.test(dom.state.html), '应弹出改名弹层');
  dom.byId('dlg-input').value = '长'.repeat(301);
  sandbox.window.App.dlgOk();
  await new Promise((r) => setImmediate(r));
  const html = dom.state.html;
  assert.ok(/标题最多 300 个字符/.test(html),
    '超长要在弹层内被拦下并说明原因，实际：' + html.replace(/\s+/g, ' ').slice(-400));
  assert.ok(/modal-wrap dlg/.test(html), '校验失败不该关窗 —— 关掉让人从头再来最气人');
  await settle(calls);
  assert.equal(calls.filter((c) => c === patchKey).length, n0, '前端已拦下的超长名不应发请求');

  sandbox.window.App.dlgCancel();
  await p;
});

await t('文档改名失败：服务端原因如实呈现，且不得出现「已改名」的成功回执', async () => {
  const patchKey = 'PATCH /api/knowledge/documents/' + DOC_ID;
  const { dom, sandbox, calls } = await openKnowledge({
    overrides: {
      [patchKey]: { status: 500, body: { ok: false, error: { code: 'internal', message: '索引盘写入失败' } } },
    },
  });
  await settle(calls);
  await clickAndAnswer(dom, sandbox,
    { 'data-act': 'renameDocument', 'data-a1': DOC_ID, 'data-a2': '权限管理规范' },
    { value: '新名字' });
  await settle(calls);
  assert.ok(calls.some((c) => c === patchKey), '应真的发 PATCH');
  const html = dom.state.html;
  assert.ok(/索引盘写入失败/.test(html), '失败原因要如实呈现，实际：' + html.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(!/已改名/.test(html), '失败时绝不能出现成功回执');
});

await t('删除文档：弹层点名具体文档（钉住列表键修复：旧代码读不存在的 documents 键，标题永远是「这个文档」）', async () => {
  const { dom, sandbox, calls } = await openKnowledge();
  await settle(calls);
  const opened = await clickAndAnswer(dom, sandbox,
    { 'data-act': 'deleteDocument', 'data-a1': DOC_ID }, { cancel: true });
  assert.ok(/删除「权限管理规范」/.test(opened),
    '删除确认必须点名**这一份**文档，实际：' + opened.replace(/\s+/g, ' ').slice(-400));
  assert.ok(!/删除「权限管理规范（文件版）」/.test(opened), '不能串到同列表里的另一份文档');
  await settle(calls);
  assert.ok(!calls.some((c) => c.startsWith('DELETE /api/knowledge/documents')), '取消后不应发 DELETE');
});

/* ── §B9 库级授权的图形化入口 ─────────────────────────────────────── */

section('真实执行：库级授权（§B9）');

await t('库级授权面板：名单来自真实响应，且对「全组织可见」的库如实说明授权是空转的', async () => {
  const { dom } = await openKnowledge();
  const html = dom.state.html;
  const flat = html.replace(/\s+/g, ' ');
  const at = flat.indexOf('库级授权');
  const dump = '；授权面板：' + flat.slice(at >= 0 ? at : -1400);

  assert.ok(at >= 0, '知识库页必须有「库级授权」面板 —— 没有它就等于"能设受限、却没法给人授权"' + dump);
  assert.ok(/全局角色 ∪ 库级角色/.test(html), '应说明本库档位是**并集**（否则会以为库级角色覆盖了全局角色）' + dump);
  assert.ok(/只作用于这个库/.test(html), '应说明并集只作用于本库' + dump);
  assert.ok(/撤权后立即回到/.test(html), '应说明撤权不残留' + dump);
  assert.ok(/列这份名单本身也要求你在/.test(html),
    '应说明"列名单也要 write 档"（名单暴露组织分工，是敏感信息）' + dump);
  assert.ok(/暂时不改变任何人的可见性/.test(html),
    '本库是「全组织可见」时必须说清授权是空转的 —— 配了半天发现没效果是最坏的用户体验' + dump);
  assert.ok(!/是 <b>受限<\/b>知识库/.test(html), '库不是受限的时候不该自称受限库' + dump);

  // 名单本身（数据来自录制期真实授权的那一条）
  assert.ok(html.includes(KB_GRANTEE), '名单应显示服务端回填的主体名（' + KB_GRANTEE + '）' + dump);
  assert.ok(/在本库的角色/.test(html), '表头要写"在本库的角色"，避免与全局角色混淆' + dump);
  assert.ok(html.includes('viewer'), '名单应显示库级角色 key' + dump);
  assert.ok(html.includes('data-a1="' + KB_GRANT_ID + '"'),
    '撤销按钮必须带**真实的绑定 id** —— 写成别的 id 会撤不掉，而页面看起来完全正常' + dump);
  assert.ok(!/读取中…/.test(html), '名单已加载时不该还显示"读取中"' + dump);

  // 表单三件
  assert.ok(dom.byId('grant-subject-type') !== null, '要有主体类型下拉（成员 / 用户组）');
  assert.ok(dom.byId('grant-subject') !== null, '要有主体下拉 —— 手填 id 既易错又泄漏内部标识');
  assert.ok(dom.byId('grant-role') !== null, '要有角色下拉');
});

await t('库切到「受限」：文案随之改变，"授权空转"的提示必须消失', async () => {
  // 形状取自真实响应，只把 visibility 换成受限的那一份（一次录制只能落在一个状态上）。
  const rec = routes['GET /api/knowledge/bases'];
  const restricted = {
    ...rec,
    body: {
      ...rec.body,
      bases: rec.body.bases.map((b) => (b.id === KB_ID ? { ...b, visibility: 'restricted' } : b)),
    },
  };
  const { dom } = await openKnowledge({ overrides: { 'GET /api/knowledge/bases': restricted } });
  const html = dom.state.html;
  const flat = html.replace(/\s+/g, ' ');
  const at = flat.indexOf('库级授权');
  const dump = '；授权面板：' + flat.slice(at >= 0 ? at : -1400);

  assert.ok(/是 <b>受限<\/b>知识库/.test(html), '受限库要说清"未获授权按不存在处理"' + dump);
  assert.ok(/下面的名单就是唯一的放行依据/.test(html), '受限库必须点明这份名单就是放行依据' + dump);
  assert.ok(!/暂时不改变任何人的可见性/.test(html), '已经是受限库了，就不该再说授权是空转的' + dump);
});

await t('列不出名单时如实说明原因，绝不假装"没有授权"（403 与"名单为空"是两件事）', async () => {
  const { dom } = await openKnowledge({
    overrides: {
      ['GET /api/knowledge/bases/' + KB_ID + '/grants']: {
        status: 403,
        body: { ok: false, error: { code: 'forbidden', message: '需要该库的 write 档' } },
      },
    },
  });
  const html = dom.state.html;
  const flat = html.replace(/\s+/g, ' ');
  const at = flat.indexOf('库级授权');
  const dump = '；授权面板：' + flat.slice(at >= 0 ? at : -1400);

  assert.ok(/列不出这份名单/.test(html), '必须点明"列不出名单"' + dump);
  assert.ok(/需要该库的 write 档/.test(html), '必须原样带出服务端给的原因（不能吞掉换成一句"没权限"）' + dump);
  assert.ok(/全局有没有 knowledge:write/.test(html),
    '必须解释这是**按库**的口径，而不是"你没权限" —— 否则库级管理员会以为自己被剥了权' + dump);
  assert.ok(!/本库还没有任何库级授权/.test(html),
    '取不到名单时**绝不能**说"没有授权" —— 那会让人以为授权丢了，而它可能好好的' + dump);
  // 呈现口径也要钉住：这是"你没这个档位"（**正常结果**），不是"加载失败"。
  // 用 `.note fail` 的红色故障样式去渲染它属于**夸大**，会让人以为平台坏了。
  // 同时钉住"面板**不藏**"：藏掉就正好藏掉了库级管理员（唯一需要它的人）。
  assert.ok(/<div class="note mt-8"><b>列不出这份名单<\/b>/.test(html),
    '列不出名单要用**中性**提示（`.note`，不是 `.note fail`）' + dump);
  assert.ok(dom.byId('grant-subject') === null, '连名单都读不到时不该给出授权表单（点下去必然失败）');
});

await t('授权动作：请求体是 {subjectType,subjectId,roleKey}，成功后重新拉名单并有可见反馈', async () => {
  const seen = [];
  const target = routes['GET /api/identity/users'].body.users[0];
  const postKey = 'POST /api/knowledge/bases/' + KB_ID + '/grants';
  const { dom, sandbox, calls } = await openKnowledge({
    overrides: {
      [postKey]: {
        ...routes[postKey],
        onCall: (opts) => { try { seen.push(JSON.parse(opts.body || '{}')); } catch { seen.push(null); } },
      },
    },
  });

  dom.byId('grant-subject').value = target.id;
  dom.byId('grant-role').value = 'viewer';
  const beforeGet = calls.filter((c) => c === 'GET /api/knowledge/bases/' + KB_ID + '/grants').length;

  await sandbox.window.App.grantBaseAccess();
  await settle(calls);

  assert.deepEqual(seen, [{ subjectType: 'user', subjectId: target.id, roleKey: 'viewer' }],
    '请求体必须恰好这三项，实际 ' + JSON.stringify(seen));
  assert.equal(calls.filter((c) => c === postKey).length, 1, '应发起一次授权请求');
  assert.equal(calls.filter((c) => c === 'GET /api/knowledge/bases/' + KB_ID + '/grants').length, beforeGet + 1,
    '授权后必须重新拉名单（否则页面还停在旧名单上）');
  assert.ok(/已授权/.test(dom.state.html), '要有可见的成功反馈（页面：'
    + dom.state.html.replace(/\s+/g, ' ').slice(0, 400) + '）');
  assert.ok(/不影响他在别处或全局的角色/.test(dom.state.html),
    '反馈要讲清"这是本库的档位"，不能说成"这个用户变成管理员了"');
});

await t('授权动作的两道前置：没选主体 / 没选角色时都不发请求（不拿猜出来的角色去授权）', async () => {
  const postKey = 'POST /api/knowledge/bases/' + KB_ID + '/grants';
  const { dom, sandbox, calls } = await openKnowledge();
  const n0 = calls.filter((c) => c === postKey).length;

  // vm 垫片里的 select 默认值是空串；真实浏览器里用户也可能压根没动过它 —— 必须被挡住。
  dom.byId('grant-subject').value = '';
  dom.byId('grant-role').value = '';
  await sandbox.window.App.grantBaseAccess();
  await settle(calls);
  assert.equal(calls.filter((c) => c === postKey).length, n0, '没选主体时不得发请求');
  assert.ok(/请选择要授权的成员/.test(dom.state.html), '要给出明确提示，不能静默什么都不做');

  dom.byId('grant-subject').value = routes['GET /api/identity/users'].body.users[0].id;
  await sandbox.window.App.grantBaseAccess();
  await settle(calls);
  assert.equal(calls.filter((c) => c === postKey).length, n0, '没选角色时不得发请求');
  assert.ok(/请选择要授的角色/.test(dom.state.html), '要给出明确提示');
});

await t('撤销动作：经事件委托派发，参数真的到达方法，且发出 DELETE', async () => {
  const delKey = 'DELETE /api/knowledge/bases/' + KB_ID + '/grants/' + KB_GRANT_ID;
  const { dom, sandbox, calls } = await openKnowledge();
  const before = calls.filter((c) => c === delKey).length;

  // 走真实的委托链路：这才能证明 HTML 里的 `data-a1`（绑定 id）与 `data-a2`（主体名）
  // 就是方法收到的参数 —— 写错了会"点了没反应"，而页面看起来完全正常。
  const dlgHtml = await clickAndAnswer(dom, sandbox, {
    'data-act': 'revokeGrant',
    'data-a1': KB_GRANT_ID,
    'data-a2': '成员「' + KB_GRANTEE + '」',
  });
  await settle(calls);

  assert.equal(calls.filter((c) => c === delKey).length, before + 1, '应发起一次撤销请求，实际调用数没变');
  // 弹层正文里必须出现**主体名**：同一页可能有好几条授权，只写"撤销这条"会让人不敢点。
  assert.ok(dlgHtml.includes(KB_GRANTEE),
    '弹层里应出现主体名，实际弹层：' + dlgHtml.replace(/\s+/g, ' ').slice(-500));
  assert.ok(/已撤销/.test(dom.state.html), '要有可见的成功反馈（页面：'
    + dom.state.html.replace(/\s+/g, ' ').slice(0, 400) + '）');
  assert.ok(!/modal-wrap dlg/.test(dom.state.html), '确认后弹层必须关掉（否则会挡住整个页面）');
});

await t('无 knowledge:read 权限：侧栏不出现知识库入口，直接敲 hash 也回落到概览', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  perms.knowledge.read = false;
  const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: perms });
  await sandbox.window.App.login();
  await settle(calls);
  assert.ok(!/知识库与检索/.test(dom.state.html), '无读权限时不应出现知识库入口');
  assert.ok(!calls.some((c) => c.includes('/api/knowledge/status')), '无读权限时不应请求知识库状态');

  dom.window.location.hash = '#/knowledge';
  dom.state.listeners['window:hashchange']();
  assert.ok(!/当前检索模式/.test(dom.state.html), '不应渲染知识库页内容');
  // 回落到**落地页**：入口藏起来还不够，手敲 hash 也得有人兜住，否则是个空白页。
  // ⚠️ 别把某一页写死（这条用例从前写的是"回落到概览"）—— 落地页规则是
  // `defaultRoute()`（见 40-delegate.js：首选工作台，没有 session:read 才退回概览），
  // 写死页面 ⇒ 规则一调整这条用例就误报，而它真正要钉的是"**无权页面必须回落**"。
  const landing = sandbox.window.App.currentRoute();
  assert.notEqual(landing.id, 'knowledge', '无权的 hash 必须回落到落地页，不能留在原地');
  assert.ok(!landing.need || landing.id !== 'knowledge', '落地页本身也得是有权访问的页面');
  // ⚠️ 0.21.12 修正：回落之后要**等异步收敛**再看渲染结果。
  //    落地页如果是工作台，`render()` 里那句 `App.wbEnsureLoaded()` 是**惰性异步**的
  //    （见 90-start.js）：它当场返回、数据稍后才到，而 `State.wb.ready` 只在第一次
  //    加载跑完后置位 —— 置位之前渲染的是 `wb-boot` 加载态，**没有 `#wb-input`**。
  //    上面那次 `hashchange()` 同步调用只跑完了 `render()`，没跑完加载链，
  //    于是"应真的渲染出落地页"会偶发失败（测的是加载态，不是落地页）。
  //    这里补一次 settle，让它跑到真正的落地页形态。
  await settle(calls);
  assert.ok(dom.state.html.includes('>' + landing.title + '</h1>')
    || (landing.id === 'workbench' && /id="wb-input"/.test(dom.state.html)),
    '应真的渲染出落地页（' + landing.title + '）');
});

/* ── 5. 治理与审计页（M3）────────────────────────────────────────── */

section('真实执行：治理与审计页');

async function openGovPage(hash, overrides = null) {
  const ctx = await runApp({ needsSetup: false, permissions: meBody.permissions, overrides });
  await ctx.sandbox.window.App.login();
  await settle(ctx.calls);
  ctx.dom.window.location.hash = hash;
  const h = ctx.dom.state.listeners['window:hashchange'];
  assert.ok(h, '应注册 hashchange 监听');
  h();
  return ctx;
}

await t('侧栏出现治理两页（审计/配额与用量），M3 不再出现在"尚未交付"里', async () => {
  const { dom } = await openGovPage('#/audit');
  const html = dom.state.html;
  for (const title of ['审计日志', '配额与用量']) {
    assert.ok(html.includes(title), '侧栏应有「' + title + '」入口');
  }
  assert.ok(!/治理与审计.*M3/.test(html.replace(/\s+/g, ' ')), 'M3 已交付，不应再挂在"尚未交付"清单');
});

await t('审计页：链尾哈希、记录表含被拦的工具调用；点校验后显示整链通过', async () => {
  const { dom, sandbox, calls } = await openGovPage('#/audit');
  let html = dom.state.html;
  assert.ok(/哈希链状态/.test(html), '应有哈希链状态面板');
  assert.ok(/链尾哈希/.test(html));
  assert.ok(/重算并校验整条链/.test(html), '应有校验按钮');

  await sandbox.window.App.verifyAudit();
  await settle(calls);
  html = dom.state.html;
  assert.ok(calls.some((c) => c.includes('/api/governance/audit/verify')), '校验按钮应真的调校验接口');
  assert.ok(/全部重算通过/.test(html), '校验后应显示链完整，实际：' + html.slice(0, 300));
});

await t('配额页：显示 turns 规则与真实已用量；用量与成本面板都出真实数字', async () => {
  const { dom } = await openGovPage('#/quotas');
  const html = dom.state.html;
  assert.ok(/配额规则/.test(html));
  assert.ok(/turns/.test(html), '应显示录制期建的 turns 配额');
  assert.ok(/block（拦截）/.test(html), '模式要如实显示');
  assert.ok(/软闸|事前闸/.test(html), '应写明配额语义边界');
  // 并发闸在 P1-2 起是真的：页面上不能再出现"未实装"（最典型的一种文档漂移），
  // 而且 concurrent 的语义必须能看见（它是瞬时在途数，没有"本周期累计"这个说法）。
  assert.ok(!/未实装/.test(html), '并发闸已实装，不该再显示"未实装"');
  assert.ok(/concurrent/.test(html) && /真·事前闸：提交回合前按在途回合数/.test(html),
    '配了 concurrent 配额的人必须能看到它的语义');
  assert.ok(/用量（来自 usage 事件/.test(html), '应有用量面板');
  // 录制期真的提交了两轮，所以这里必须是真实数字，而不是空态
  assert.ok(!/还没有任何回合产生 usage 事件/.test(html), '录制期已提交回合 → 不该再显示"还没有"空态');
  assert.ok(/按用户/.test(html), '有用量时应渲染按用户表');
});

await t('配额页 · 成本面板：金额按单价算出、未归因单独成桶、口径写在页面上', async () => {
  const { dom } = await openGovPage('#/quotas');
  const html = dom.state.html;
  assert.ok(/成本估算/.test(html), '应渲染成本面板');
  assert.ok(/CNY 2\.56/.test(html), '金额应按录制期配的单价算出来（128×1分 + 64×2分）：'
    + html.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(/rec-chat/.test(html), '要显示"用量记录的模型名"，否则这个数没法核对');
  assert.ok(/录制对话模型/.test(html), '要显示归因到了哪一条条目');
  assert.ok(/未归因/.test(html), '未选模型的那一轮（192 token）要出现在「未归因」桶里');
  assert.ok(/192/.test(html), '未归因的 token 数要如实显示');
  // 口径三件套必须出现在页面上：单位、不追溯、未定价≠0
  assert.ok(/最小货币单位/.test(html), '金额单位要写清（分/美分，整数）');
  assert.ok(/不追溯|当前登记的单价/.test(html), '必须写明"按当前单价估算"');
  assert.ok(/不是 0|不是 ¥0|未定价/.test(html), '必须写明"未定价显示为未定价，不是 0 元"');
    assert.ok(/每 100 万 token/.test(html), '单价单位要写在页面上（写成"元"会差 100 倍）');
  // 缓存价没配 → 该列显示「未定价」，绝不能拿输入价顶替出一个数
  assert.ok(/缓存读/.test(html), '四类 token 的价都要列出来');
});

await t('配额页：没有任何用量时，用量与成本**都**如实空态（不编 0 元）', async () => {
  const costRoute = routes['GET /api/governance/cost'];
  const { dom } = await openGovPage('#/quotas', {
    'GET /api/governance/usage': {
      status: 200,
      body: {
        totals: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, billableInput: 0, usageRows: 0 },
        byDay: [], byUser: [], bySession: [], sampled: 0, semantics: {},
      },
    },
    'GET /api/governance/cost': {
      status: 200,
      body: {
        ...costRoute.body,
        summary: {
          items: [], unattributed: { usageRows: 0, tokens: 0 },
          totalsByCurrency: {}, mixedCurrency: false, notes: [],
        },
      },
    },
  });
  const html = dom.state.html;
  assert.ok(/还没有任何回合产生 usage 事件/.test(html), '用量面板要显示诚实空态');
  assert.ok(/未定价/.test(html), '没有已定价用量时显示「未定价」');
  // 这是本页最要紧的一条：**不能**把"没数据/没定价"渲染成 ¥0.00。
  // 0.00 会被读成"这个月没花钱"，而真相是"我们还不知道花了多少"。
  assert.ok(!/CNY 0\.00/.test(html), '绝不能出现 CNY 0.00 这种把"不知道"变成"免费"的渲染');
  assert.ok(/我们还不知道花了多少/.test(html), '空态要直说"不知道花了多少"，而不是给一个 0');
});

await t('能力清单页：Skill / MCP / 插件三段渲染；工具段整块不再存在', async () => {
  const { dom, sandbox, calls } = await openGovPage('#/capabilities');
  const html = dom.state.html;
  assert.ok(/Skill（平台登记/.test(html), '应有 Skill 登记表');
  assert.ok(/MCP 服务（/.test(html), '应有 MCP 表');
  // ⚠️ 0.21.10：工具段整块删除（登记表 + 内核探测双来源表 + 差距行 + 停用按钮）。
  //    这里**反向钉**：不仅"不渲染"，而是"页面上根本不该再有这些痕迹"。
  //    为什么反向钉而不是删掉断言：如果只删断言，将来谁把那段代码粘回来，测试不会响。
  assert.ok(!/工具（登记 \d+ 个/.test(html), '不应再渲染双来源工具表');
  assert.ok(!/工具（内核探测/.test(html), '不应再渲染工具表（旧形态）');
  assert.ok(!/不记录任何一轮对话实际调用了什么/.test(html), '工具段的口径注也不应还在');
  assert.ok(!/<th>内核探测<\/th>/.test(html), '不应再有"内核探测"列');
  assert.ok(!/<span class="badge ok">已登记<\/span>/.test(html), '不应再有工具登记态徽标');
  assert.ok(!/stub\.echo/.test(html), '工具名不应出现在能力清单页：' + html.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(!/legacy-mcp-tool/.test(html), '内核没有但登记过的工具也不该再有差距行');
  // 分段顺序（0.20.0 起，0.21.10 去掉工具段）：Skill → MCP 服务 →（插件）
  const iSkill = html.indexOf('Skill（平台登记');
  const iMcp = html.indexOf('MCP 服务（');
  assert.ok(iSkill !== -1 && iMcp !== -1, '两段 panel 都要存在');
  assert.ok(iSkill < iMcp, '顺序必须是 Skill→MCP，实际 index：' + [iSkill, iMcp].join(','));
  const iPlug = html.indexOf('插件（上游插件目录');
  if (iPlug !== -1) assert.ok(iMcp < iPlug, '插件段若在渲染必须排在 MCP 之后');
  assert.ok(/真实探测结果/.test(html), 'MCP 面板要写明健康是真实探测');
  // App.toggleTool 已随工具段一起删除；这里钉住"它真的没了"，
  // 免得回放页残留一个点了 404 的按钮（或更坏：一个什么都不做的空函数）。
  assert.equal(typeof sandbox.window.App.toggleTool, 'undefined',
    'App.toggleTool 应已删除（不是留个空壳）');
  assert.ok(!calls.some((c) => /\/api\/capability\/tools\//.test(c)),
    '页面加载不得再请求工具启停接口：' + JSON.stringify(calls.filter((c) => /tools/.test(c))));
});

await t('Skill 卸载：走确认弹层（取消不发请求）；确认后发 DELETE 并把服务端口径带进回执', async () => {
  const { dom, sandbox, calls } = await openGovPage('#/capabilities');
  await settle(calls); // 首拉静下来，再数增量
  let html = dom.state.html;
  assert.ok(html.includes('data-act="removeSkill" data-a1="rec-skill-zip"'), 'zip 冒烟技能行内应有卸载按钮');
  assert.ok(html.includes('data-act="removeSkill" data-a1="rec-skill-import"'), 'import 冒烟技能行内应有卸载按钮');
  // 取消路径：弹层要讲清不可逆与替代方案；取消后一个请求都不许发
  const n0 = calls.length;
  const opened = await clickAndAnswer(dom, sandbox, { 'data-act': 'removeSkill', 'data-a1': 'rec-skill-zip' }, { cancel: true });
  assert.ok(/卸载 Skill/.test(opened), '弹层标题应写明「卸载 Skill」，实际：' + opened.slice(0, 300));
  assert.ok(/不可恢复/.test(opened), '必须明说不可逆');
  assert.ok(/请改用「停用」/.test(opened), '要指出"只是暂时不想用"的替代路径');
  await settle(calls);
  assert.equal(calls.length, n0, '取消后不应发任何请求');
  // 确认路径：真发 DELETE，回执带服务端 note（诚实口径：目录已删）
  await clickAndAnswer(dom, sandbox, { 'data-act': 'removeSkill', 'data-a1': 'rec-skill-zip' });
  await settle(calls);
  assert.ok(calls.some((c) => c === 'DELETE /api/capability/skills/rec-skill-zip'), '确认后应真的发 DELETE');
  html = dom.state.html;
  assert.ok(/已卸载 Skill/.test(html), '要有可见回执，实际：' + html.slice(0, 300));
  assert.ok(html.includes(routes['DELETE /api/capability/skills/rec-skill-zip'].body.note), '回执应带服务端 note（安装目录已随卸载删除）');
});

await t('Skill 卸载（import 来源）：同样发 DELETE，回执如实说"只注销登记"', async () => {
  const { dom, sandbox, calls } = await openGovPage('#/capabilities');
  await settle(calls);
  await clickAndAnswer(dom, sandbox, { 'data-act': 'removeSkill', 'data-a1': 'rec-skill-import' });
  await settle(calls);
  assert.ok(calls.some((c) => c === 'DELETE /api/capability/skills/rec-skill-import'), '应发 DELETE');
  const note = routes['DELETE /api/capability/skills/rec-skill-import'].body.note;
  assert.ok(dom.state.html.includes(note), '回执要带服务端 note（只注销登记，未删除任何目录）');
});

await t('Skill 卸载失败：错误原文如实呈现，且不得出现"已卸载"的成功回执', async () => {
  const key = 'DELETE /api/capability/skills/rec-skill-zip';
  const overrides = {};
  overrides[key] = { status: 500, body: { ok: false, error: { code: 'remove_failed', message: '安装目录删除失败，登记保留（可修复后重试）：EBUSY' } } };
  const { dom, sandbox, calls } = await openGovPage('#/capabilities', overrides);
  await settle(calls);
  await clickAndAnswer(dom, sandbox, { 'data-act': 'removeSkill', 'data-a1': 'rec-skill-zip' });
  await settle(calls);
  assert.ok(calls.some((c) => c === key), '应真的发 DELETE');
  const html = dom.state.html;
  assert.ok(/登记保留/.test(html), '失败原因要如实呈现给用户，实际：' + html.slice(0, 300));
  assert.ok(!/已卸载 Skill/.test(html), '失败时绝不能出现成功回执');
});

await t('Skill 卸载权限收敛：无 skill:write 不渲染卸载按钮，也不发 DELETE', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  assert.ok(perms.skill && typeof perms.skill.write === 'boolean', '前置：矩阵应显式含 skill 资源（否则本用例测不到东西）');
  perms.skill.write = false;
  const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: perms });
  await sandbox.window.App.login();
  await settle(calls);
  dom.window.location.hash = '#/capabilities';
  const h = dom.state.listeners['window:hashchange'];
  assert.ok(h, '应注册 hashchange 监听');
  h();
  const html = dom.state.html;
  assert.ok(/Skill（平台登记/.test(html), 'skill:read 还在，能力页应照常渲染');
  assert.ok(/更新检测/.test(html), '只读方仍应能用更新检测');
  assert.ok(!html.includes('data-act="removeSkill"'), '无 skill:write 不应渲染卸载按钮');
  await settle(calls);
  assert.ok(!calls.some((c) => c.startsWith('DELETE /api/capability/skills')), '不应发送任何卸载 DELETE');
});

await t('来源页：导出按钮真调导出接口且提示脱敏；导入区在', async () => {
  const { dom, sandbox, calls } = await openGovPage('#/capSources');
  let html = dom.state.html;
  assert.ok(/导出（脱敏）/.test(html));
  assert.ok(/绝不导出/.test(html), '页面上要写明 MCP 配置的脱敏红线');
  // ⚠️ 0.21.10：原来这里钉「工具来源分组（登记表 2 个）」（内置 1 / MCP 1）。
  //    工具不再是可登记的能力，来源页的那个分组panel整块删除，所以断言**反向**：
  //    分组标题、两个分组计数、以及"不是按名字推断的"那句口径注都不得再出现。
  //    留着正向断言会让这条用例永久失败；直接删掉断言则等于放弃"那段代码真的走了"的证明 ——
  //    所以反向钉：谁把工具来源分组粘回来，这里立刻红。
  assert.ok(!/工具来源分组/.test(html), '来源页不应再有工具来源分组，实际：'
    + html.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(!/内置（\d+）/.test(html) && !/MCP（\d+）/.test(html), '按 origin 分组的工具计数不应还在');
  assert.ok(!/不是按名字推断的/.test(html), '来源由登记字段决定的说明属于工具段，应随之删除');
  // Skill / MCP 两个真正还在的来源概念仍要有分组，别把删除做过头
  assert.ok(/Skill/.test(html), '来源页仍要讲 Skill');
  assert.ok(/MCP/.test(html), '来源页仍要讲 MCP');

  await sandbox.window.App.exportCaps();
  await settle(calls);
  assert.ok(calls.some((c) => c === 'GET /api/capability/export'), '导出应真的调导出接口');
  html = dom.state.html;
  assert.ok(/脱敏红线/.test(html), '导出后应有可见反馈');
  // 导出的口径已不含工具段；页面文案要如实（"工具与绑定原样"改为"绑定原样"）
  assert.ok(!/工具与绑定原样/.test(html), '导出说明不应再承诺"工具原样"');
  assert.ok(/import-json/.test(html), '导入粘贴区应存在');
  // 导入区必须**如实**交代旧包：含 tools 段的旧导出会被忽略，而不是报错
  assert.ok(/旧版本导出包里若含/.test(html), '导入区要写明旧包里的 tools 段会被忽略');
});

await t('可见性治理页：绑定表 + 新增绑定表单 + 语义说明（deny 永远赢）', async () => {
  const { dom, sandbox, calls } = await openGovPage('#/capPolicies');
  let html = dom.state.html;
  assert.ok(/可见性绑定（/.test(html));
  assert.ok(/deny 永远赢/.test(html), '要写明判定语义');
  assert.ok(/bind-captype/.test(html), '应有新增绑定表单');

  await sandbox.window.App.setBinding();
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/capability/bindings'), '保存绑定应真的调接口');
  html = dom.state.html;
  assert.ok(/绑定已保存|保存绑定/.test(html) || /已保存/.test(html), '保存要有可见反馈');
});

await t('权限收敛：去掉 read 即不渲染不请求；viewer 保留的能力页入口不受影响', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  for (const r of ['audit', 'quota']) perms[r].read = false;
  const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: perms });
  await sandbox.window.App.login();
  await settle(calls);
  assert.ok(!/审计日志/.test(dom.state.html), '无 audit:read 不应出现审计入口');
  assert.ok(!calls.some((c) => c.includes('/api/governance/audit')), '不应请求审计接口');
  assert.ok(!calls.some((c) => c.includes('/api/governance/quotas')), '不应请求配额接口');
  // viewer 矩阵（M1 起）显式含 capability/skill/tool/mcp 的 read —— 能力页入口应保留
  assert.ok(/能力清单/.test(dom.state.html), 'viewer 有 skill:read，能力清单入口应保留');
  assert.ok(!calls.some((c) => c.includes('/api/capability/bindings') && !c.includes('GET')),
    'viewer 只读，不应发绑定写请求');
});

/* ── 备份与恢复页（P0-D 补页）────────────────────────────────── */

section('备份与恢复页：列表 / 创建 / 校验 + 权限收敛');

await t('备份页：列出真实备份文件、显示目录、创建与校验按钮真的调接口', async () => {
  const { dom, sandbox, calls } = await openGovPage('#/backup');
  let html = dom.state.html;
  assert.ok(/备份与恢复/.test(html), '应能进入备份页');
  assert.ok(/已存在的备份/.test(html), '应有备份列表面板');
  assert.ok(/立即创建备份/.test(html), '应有创建按钮');
  assert.ok(/主密钥/.test(html) && /不进备份包/.test(html), '必须写明主密钥不进包');
  assert.ok(/不做在线接口/.test(html), '必须写明恢复是离线动作（不假装有在线恢复）');
  // 录制期建的备份文件应出现在列表里（不是空态）
  const listed = routes['GET /api/operation/backup'].body.items[0].file;
  assert.ok(html.includes(listed), '列表应渲染真实备份文件名：' + listed);

  // 创建按钮：真的发 POST
  await sandbox.window.App.createBackup();
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/operation/backup'), '创建按钮应调 POST /api/operation/backup');
  assert.ok(/备份已创建/.test(dom.state.html), '创建后应给出可读反馈');

  // 校验按钮：真的发校验请求并显示通过
  await sandbox.window.App.verifyBackup(listed);
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/operation/backup/verify'), '校验按钮应调校验接口');
  assert.ok(/校验通过/.test(dom.state.html), '校验通过后应显示结果，实际：' + dom.state.html.slice(0, 300));
});

await t('备份删除（E3）：按钮逐一渲染；确认弹层点名文件并写明护栏；取消零请求；确认后发 DELETE 并重拉列表', async () => {
  const delKey = 'DELETE /api/operation/backup/' + E3_DEL_NAME;
  const listKey = 'GET /api/operation/backup';
  const { dom, sandbox, calls } = await openGovPage('#/backup');
  await settle(calls);

  // 渲染：每份备份各有一个删除入口（录制期列表是 A、B 两份）
  const items = routes[listKey].body.items;
  assert.ok(items.length >= 2, '前置：录制期的列表应有 A、B 两份备份');
  for (const b of items) {
    assert.ok(dom.state.html.includes('data-act="deleteBackup" data-a1="' + b.file + '"'),
      '每份备份都应有删除入口：' + b.file);
  }

  // 取消路径：弹层点名**这一份**文件、写明不可逆与护栏；取消后一个请求都不许发
  const opened = await clickAndAnswer(dom, sandbox,
    { 'data-act': 'deleteBackup', 'data-a1': E3_DEL_NAME }, { cancel: true });
  assert.ok(/删除备份文件/.test(opened), '弹层标题应写明「删除备份文件」');
  assert.ok(opened.includes('删除「' + E3_DEL_NAME + '」'),
    '确认弹层必须点名**这一份**文件，实际：' + opened.replace(/\s+/g, ' ').slice(-400));
  assert.ok(/不可逆/.test(opened), '弹层要写明删除不可逆（没有回收站）');
  assert.ok(/平台护栏/.test(opened) && /最后一份/.test(opened), '弹层要写明"只删本平台产物、绝不删最后一份"的护栏');
  await settle(calls);
  assert.ok(!calls.some((c) => c.startsWith('DELETE /api/operation/backup')), '取消后不应发 DELETE');

  // 确认路径：真的发 DELETE（路径与编码正确），成功后重拉列表
  const n0 = calls.filter((c) => c === listKey).length;
  await clickAndAnswer(dom, sandbox, { 'data-act': 'deleteBackup', 'data-a1': E3_DEL_NAME });
  await settle(calls);
  assert.ok(calls.some((c) => c === delKey), '应真的发 DELETE，键=' + delKey);
  const html = dom.state.html;
  assert.ok(html.includes('已删除备份「' + E3_DEL_NAME + '」'),
    '要有可见回执，实际：' + html.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(/还剩 1 份/.test(html), '回执要带服务端返回的剩余份数');
  assert.ok(!/modal-wrap dlg/.test(html), '确认后弹层应关闭');
  assert.ok(calls.filter((c) => c === listKey).length > n0, '删除后应重新拉备份列表');
  // 回放不重建状态：重拉拿到的仍是录制快照（A、B 都在）—— 这是回放的边界，不是缺陷；
  // 本用例的断言对象是请求路径与回执（上面几条），不是快照内容。
});

await t('备份删除失败（如最后一份 409）：原因如实呈现，且不得出现「已删除备份」成功回执', async () => {
  const delKey = 'DELETE /api/operation/backup/' + E3_DEL_NAME;
  const { dom, sandbox, calls } = await openGovPage('#/backup', {
    [delKey]: { status: 409, body: { ok: false, error: { code: 'conflict', message: '这是最后一份备份，拒绝删除 —— 磁盘满是问题，没有备份是灾难' } } },
  });
  await settle(calls);
  await clickAndAnswer(dom, sandbox, { 'data-act': 'deleteBackup', 'data-a1': E3_DEL_NAME });
  await settle(calls);
  assert.ok(calls.some((c) => c === delKey), '应真的发 DELETE');
  const html = dom.state.html;
  assert.ok(/没有备份是灾难/.test(html), '失败原因要如实呈现，实际：' + html.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(!/已删除备份/.test(html), '失败时绝不能出现成功回执');
});

await t('备份页权限收敛（删除）：无 operation:delete 仍可看可建，但不渲染删除按钮、不发 DELETE', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  assert.ok(perms.operation && perms.operation.delete === true,
    '前置：owner 矩阵应显式含 operation.delete（否则本用例测不到东西）');
  perms.operation.delete = false;
  const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: perms });
  await sandbox.window.App.login();
  await settle(calls);
  dom.window.location.hash = '#/backup';
  const h = dom.state.listeners['window:hashchange'];
  assert.ok(h, '应注册 hashchange 监听');
  h();
  const html = dom.state.html;
  assert.ok(/备份与恢复/.test(html), 'operation:read 还在，备份页应照常渲染');
  assert.ok(/立即创建备份/.test(html), 'operation:write 还在，创建按钮应保留');
  assert.ok(!html.includes('data-act="deleteBackup"'), '无 operation:delete 不应渲染删除按钮');
  assert.ok(!/绝不删最后一份/.test(html), '页脚的删除护栏说明应随按钮一起去（没有按钮就不说这句）');
  await settle(calls);
  assert.ok(!calls.some((c) => c.startsWith('DELETE /api/operation/backup')), '不应发送任何删除请求');
});

await t('备份页权限收敛：无 operation:read 时侧栏无入口，也不请求备份接口', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  assert.ok(perms.operation, '前置：owner 的权限矩阵应显式含 operation 资源（否则本用例测不到东西）');
  perms.operation.read = false;
  const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: perms });
  await sandbox.window.App.login();
  await settle(calls);
  assert.ok(!/备份与恢复/.test(dom.state.html), '无 operation:read 不应出现备份入口');
  assert.ok(!calls.some((c) => c.includes('/api/operation/backup')), '不应请求备份接口');
});

/* ── 用户组页（P0-D #8）──────────────────────────────────────── */

section('用户组页：真实组列表 / 角色即权限 / 动作真的发请求 / 权限收敛');

await t('组页：渲染录到的真实组、角色中文名、成员由账号列表反查、语义说明齐全', async () => {
  const gid = globalThis.__groupId;
  const { dom } = await openGovPage('#/groups');
  const html = dom.state.html;
  assert.ok(/用户组/.test(html), '应能进入用户组页');

  const g = routes['GET /api/identity/groups'].body.groups.find((x) => x.id === gid);
  assert.ok(g, '前置：录制期建的组应在列表里');
  assert.ok(html.includes(g.name), '应渲染真实组名：' + g.name);
  assert.ok(/只读访客/.test(html), '组持有的 viewer 角色应显示成中文名，而不是裸 key');

  // 成员名不来自组接口：组列表只给 memberCount，成员由账号列表的 user.groups 反查
  const admin = routes['GET /api/identity/users'].body.users[0];
  assert.ok(html.includes(admin.displayName) || html.includes(admin.username),
    '成员名应从账号列表反查出来（组页不额外请求成员接口）');

  assert.ok(/有效角色 = 直接绑定 ∪ 所属组绑定/.test(html), '必须写明角色并集的语义');
  assert.ok(/整体回滚/.test(html), '必须写明"最后一个所有者"的保护会穿透到组');
  assert.ok(/组本身/.test(html) && /不含任何权限/.test(html), '要说明组本身不含权限，只是角色载体');
});

/* 部门面板的渲染依赖 `/api/identity/departments`。录制期此刻是 0 个部门，
 * 所以这两个用例显式注入"有 1 个部门"的响应 —— 不注入就永远测不到
 * "表格真的渲染出部门行"以及"改归属真的能选中一个部门"这两件事。 */
const DEPT_PROBE = {
  id: 'dep_probe', orgId: 'org_probe', name: '前端回归部门',
  parentId: null, memberCount: 1, createdAt: '2026-10-02T00:00:00.000Z',
};

await t('账号页：部门面板与"部门"列都在，且如实声明「部门不是权限载体」', async () => {
  const base = routes['GET /api/identity/departments'];
  const { dom } = await openGovPage('#/users', {
    'GET /api/identity/departments': { ...base, body: { ...base.body, departments: [DEPT_PROBE] } },
  });
  const html = dom.state.html;
  assert.ok(/部门（1 个）/.test(html), '部门面板要显示真实数量，实际片段：'
    + html.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(html.includes('前端回归部门'), '部门表要真的把名字渲染出来');
  assert.ok(/1 人/.test(html), '成员数要显示（0 与"没查到"必须能区分）');
  // 表头必须有"部门"列 —— 否则归属写进去了却看不见，等于没做
  assert.ok(/<th>部门<\/th>/.test(html), '账号表应有「部门」列');
  // 这句文案是**功能的一部分**：叫"管理员部"的部门不给人任何权限，
  // 不说清就会有人把它当成一种授权方式。
  assert.ok(/部门不是权限载体/.test(html), '必须写清部门不改变任何权限');
  // 出口补齐（0.17.0）：管理员行里要看得到「改名 / 删除」——按钮存在才叫"有出口"。
  assert.ok(/data-act="renameDepartment"/.test(html), '部门行应有改名按钮');
  assert.ok(/data-act="deleteDepartment"/.test(html), '部门行应有删除按钮');
});

await t('账号页动作：新建部门真的 POST，并给可见反馈', async () => {
  const { dom, sandbox, calls } = await openGovPage('#/users');
  dom.byId('nd-name').value = '动作探针部门';
  await sandbox.window.App.createDepartment();
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/identity/departments'), '新建部门应真的 POST');
  assert.ok(/已创建/.test(dom.state.html), '建部门后要有可见反馈，实际：'
    + dom.state.html.replace(/\s+/g, ' ').slice(0, 300));
});

await t('账号页动作：改归属真的 PUT 到用户资料接口（**选项是渲染出来的**，不是让人输名字）', async () => {
  const base = routes['GET /api/identity/departments'];
  const { dom, sandbox, calls } = await openGovPage('#/users', {
    'GET /api/identity/departments': { ...base, body: { ...base.body, departments: [DEPT_PROBE] } },
  });
  const u = routes['GET /api/identity/users'].body.users[0];
  // 0 号选项是「（不归属任何部门）」，1 号才是真实部门 —— 选 1 号。
  const p = sandbox.window.App.setUserDept(u.id);
  const dlgHtml = await answer(sandbox, dom, { pick: [1] });
  await p;
  await settle(calls);
  assert.ok(calls.some((c) => c === 'PUT /api/identity/users/' + u.id), '改归属应真的 PUT 用户资料');
  // 部门名必须**出现在弹层里**（作为选项）而不是靠用户记 —— 让用户输名字等于把
  // "有哪些部门"这件服务端已经知道的事推给人，输错就白跑一趟。
  assert.ok(dlgHtml.includes(DEPT_PROBE.name), '部门应以**选项**形式出现在弹层里，实际：'
    + dlgHtml.replace(/\s+/g, ' ').slice(-500));
  assert.ok(/（不归属任何部门）/.test(dlgHtml), '要提供"清空归属"这一项，否则归属一旦设上就去不掉');
});

await t('账号页动作：改归属按**取消**时，一个请求都不该发（把"没选"当成一种选择）', async () => {
  const base = routes['GET /api/identity/departments'];
  const { dom, sandbox, calls } = await openGovPage('#/users', {
    'GET /api/identity/departments': { ...base, body: { ...base.body, departments: [DEPT_PROBE] } },
  });
  const u = routes['GET /api/identity/users'].body.users[0];
  const before = calls.length;
  const p = sandbox.window.App.setUserDept(u.id);
  await answer(sandbox, dom, { cancel: true });
  await p;
  await settle(calls);
  assert.equal(calls.length, before, '取消不是"提交空值"，不该发出任何请求');
  assert.ok(!/modal-wrap dlg/.test(dom.state.html), '取消后弹层要关掉');
});

await t('账号页动作：改姓名弹层**预填当前姓名**，确认后真的 PUT 用户资料接口，可取消', async () => {
  const u = routes['GET /api/identity/users'].body.users.find((x) => x.username === 'rec-editor');
  assert.ok(u, '前置：账号 fixture 里应有 rec-editor');
  const putKey = 'PUT /api/identity/users/' + u.id;
  const putBodies = [];
  const overrides = {};
  overrides[putKey] = Object.assign({}, routes[putKey], {
    onCall: (opts) => putBodies.push(JSON.parse(opts.body || '{}')),
  });
  const { dom, sandbox, calls } = await openGovPage('#/users', overrides);

  assert.ok(dom.state.html.includes('data-act="setUserName" data-a1="' + u.id + '"'), '账号行应渲染「改姓名」按钮');

  const before = calls.length;
  const p = sandbox.window.App.setUserName(u.id);
  const dlgHtml = await answer(sandbox, dom, { value: '回归专用账号（新）' });
  await p;
  await settle(calls);
  // 锚在输入框 value 上：改名最常见的操作是"在原名上修两个字"，让人从空白重打是纯手指税。
  assert.ok(/id="dlg-input"[^>]*value="回归专用账号"/.test(dlgHtml),
    '弹层输入框应预填当前姓名，实际：' + dlgHtml.replace(/\s+/g, ' ').slice(-400));
  assert.ok(calls.slice(before).some((c) => c === putKey), '改姓名应真的 PUT 用户资料接口');
  assert.deepEqual(putBodies, [{ displayName: '回归专用账号（新）' }], '改姓名应只 PUT displayName 字段（不是整个用户对象）');
  assert.ok(/已改为/.test(dom.state.html), '改名后要有可见反馈，实际：'
    + dom.state.html.replace(/\s+/g, ' ').slice(0, 300));

  // 取消：不发请求（与改归属同一条纪律）
  const before2 = calls.length;
  const p2 = sandbox.window.App.setUserName(u.id);
  await answer(sandbox, dom, { cancel: true });
  await p2;
  await settle(calls);
  assert.equal(calls.length, before2, '取消不是"改成空名"，一个请求都不该发');
});

await t('账号页动作：部门改名弹层**预填当前名字**，确认后真的 PATCH，并给可见反馈', async () => {
  const base = routes['GET /api/identity/departments'];
  const { dom, sandbox, calls } = await openGovPage('#/users', {
    'GET /api/identity/departments': { ...base, body: { ...base.body, departments: [DEPT_PROBE] } },
    'PATCH /api/identity/departments/dep_probe': {
      status: 200,
      body: { ok: true, department: { ...DEPT_PROBE, name: '前端回归部门（改后）' } },
    },
  });
  const before = calls.length;
  const p = sandbox.window.App.renameDepartment('dep_probe');
  const dlgHtml = await answer(sandbox, dom, { value: '前端回归部门（改后）' });
  await p;
  await settle(calls);
  // 断言锚在输入框的 value 上（弹层正文里也有名字，不能拿整段 HTML 蒙混过关）：
  // 改名最常见的操作是"在原名字上修两个字"，让人从空白重打一遍是纯手指税。
  assert.ok(/id="dlg-input"[^>]*value="前端回归部门"/.test(dlgHtml),
    '弹层输入框应预填当前名字，实际：' + dlgHtml.replace(/\s+/g, ' ').slice(-400));
  assert.ok(calls.slice(before).some((c) => c === 'PATCH /api/identity/departments/dep_probe'), '改名应真的 PATCH');
  assert.ok(/已改名/.test(dom.state.html), '改名后要有可见反馈，实际：'
    + dom.state.html.replace(/\s+/g, ' ').slice(0, 300));
});

await t('账号页动作：部门改名按**取消**时不发任何请求（把"没改"当成没改）', async () => {
  const base = routes['GET /api/identity/departments'];
  const { dom, sandbox, calls } = await openGovPage('#/users', {
    'GET /api/identity/departments': { ...base, body: { ...base.body, departments: [DEPT_PROBE] } },
  });
  const before = calls.length;
  const p = sandbox.window.App.renameDepartment('dep_probe');
  await answer(sandbox, dom, { cancel: true });
  await p;
  await settle(calls);
  assert.equal(calls.length, before, '取消不是"改成空名"，一个请求都不该发');
  assert.ok(!/modal-wrap dlg/.test(dom.state.html), '取消后弹层要关掉');
});

await t('账号页动作：删**有成员**的部门时不发请求，直接弹「无法删除」并说清人数', async () => {
  const base = routes['GET /api/identity/departments'];
  const { dom, sandbox, calls } = await openGovPage('#/users', {
    'GET /api/identity/departments': { ...base, body: { ...base.body, departments: [DEPT_PROBE] } },
  });
  const before = calls.length;
  const p = sandbox.window.App.deleteDepartment('dep_probe');   // DEPT_PROBE.memberCount = 1
  const dlgHtml = await answer(sandbox, dom);
  await p;
  await settle(calls);
  assert.ok(/无法删除/.test(dlgHtml), '有成员的部门应弹「无法删除」，实际：'
    + dlgHtml.replace(/\s+/g, ' ').slice(-400));
  assert.ok(/1 个成员/.test(dlgHtml), '要把人数说清楚（"操作失败"不算解释）');
  assert.equal(calls.length, before, '预检就拦住了，一个请求都不该发（服务端仍有同样的护栏兜底）');
});

await t('账号页动作：删**无引用**的部门先弹确认（danger），确认后真的 DELETE 并给可见反馈', async () => {
  const free = { ...DEPT_PROBE, id: 'dep_free', name: '前端游离部门', memberCount: 0, childCount: 0 };
  const base = routes['GET /api/identity/departments'];
  const { dom, sandbox, calls } = await openGovPage('#/users', {
    'GET /api/identity/departments': { ...base, body: { ...base.body, departments: [free] } },
    'DELETE /api/identity/departments/dep_free': { status: 200, body: { ok: true, id: 'dep_free' } },
  });
  const before = calls.length;
  const p = sandbox.window.App.deleteDepartment('dep_free');
  const dlgHtml = await answer(sandbox, dom);
  await p;
  await settle(calls);
  assert.ok(/删除部门/.test(dlgHtml) && dlgHtml.includes('前端游离部门'), '应先弹确认且把要删的名字写清楚，实际：'
    + dlgHtml.replace(/\s+/g, ' ').slice(-400));
  assert.ok(/id="dlg-ok" class="danger"/.test(dlgHtml), '删除是不可逆动作，确认按钮要是 danger 样式');
  assert.ok(calls.slice(before).some((c) => c === 'DELETE /api/identity/departments/dep_free'), '确认后应真的 DELETE');
  assert.ok(/已删除/.test(dom.state.html), '删除后要有可见反馈，实际：'
    + dom.state.html.replace(/\s+/g, ' ').slice(0, 300));
});

await t('账号页权限收敛：无 department:write / delete 时，部门表不给改名 / 删除按钮', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  assert.ok(perms.department, '前置：权限矩阵应显式含 department 资源');
  perms.department.write = false;
  perms.department.delete = false;
  const base = routes['GET /api/identity/departments'];
  const { dom, sandbox, calls } = await runApp({
    needsSetup: false, permissions: perms,
    overrides: { 'GET /api/identity/departments': { ...base, body: { ...base.body, departments: [DEPT_PROBE] } } },
  });
  await sandbox.window.App.login();
  await settle(calls);
  dom.window.location.hash = '#/users';
  dom.state.listeners['window:hashchange']();
  const html = dom.state.html;
  assert.ok(html.includes(DEPT_PROBE.name), '前置：有 read 权限，部门表应该还在');
  assert.ok(!/data-act="createDepartment"/.test(html), '没有 write 不该出现「新建部门」');
  assert.ok(!/data-act="renameDepartment"/.test(html), '没有 write 不该出现「改名」');
  assert.ok(!/data-act="deleteDepartment"/.test(html), '没有 delete 不该出现「删除」（删除能力是单独声明的）');
});

await t('账号页：角色来自组时标出来（否则管理员不知道该去哪撤销）', async () => {
  const { dom } = await openGovPage('#/users');
  const html = dom.state.html;
  const admin = routes['GET /api/identity/users'].body.users[0];
  assert.ok((admin.groups || []).length, '前置：录制期已把该账号加进组');
  assert.ok(/⚠|⤴/.test(html) || /来自组/.test(html), '组带来的角色必须带标记，实际片段：'
    + html.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(html.includes(admin.groups[0].name), '账号页应显示所属组名');
});

/* ── 账号批量导入（0.17.0）────────────────────────────────────────
   录到的报表是 created=2 / failed=1（第 4 行与根账号重名）—— 于是"好行真建、
   坏行只跳过自己、行号可回 Excel 定位"这些业务语义在 UI 上全是可断言的事实。 */

await t('账号页：批量导入面板在场 —— 按钮是触发器、文件输入藏起来、列说明写清楚', async () => {
  const { dom } = await openGovPage('#/users');
  const html = dom.state.html;
  assert.ok(/data-act="importUsers"/.test(html), '应有「选择 CSV 文件…」按钮');
  // 文件输入必须**藏起来**且用 class 隐藏（内联 style 有冻结计数，只减不增）。
  // 用户看到的入口只有按钮 —— 一个裸露的文件输入框会让人以为"要在这里拖文件"。
  assert.ok(/id="nu-file"[^>]*class="hidden"[^>]*data-change="usersCsvChosen"/.test(html),
    '文件输入应 class="hidden" 且挂 data-change="usersCsvChosen"，实际：'
    + (html.match(/<input[^>]*nu-file[^>]*>/) || ['(没有这个 input)'])[0]);
  assert.ok(/accept="\.csv,text\/csv"/.test(html), '文件选择框应只收 .csv');
  assert.ok(/单次最多 500 行/.test(html), '行数上限要写在面板上（否则用户拿 2000 行来问"为什么不全"）');
  assert.ok(/GBK/.test(html), '编码兜底（Excel 中文版另存为 GBK）要写明，否则乱码账号会"看起来导入成功"');
});

await t('账号页动作：选中 CSV → 解码 → POST 原文 → 报表弹层逐行给行号（口令绝不回显）', async () => {
  let sent = null;
  const { dom, sandbox, calls } = await openGovPage('#/users', {
    'POST /api/identity/users/import': {
      ...routes['POST /api/identity/users/import'],
      onCall: (opts) => { sent = JSON.parse(opts.body); },
    },
  });
  const csvText = 'username,password,displayName,dept,roles\nfe-ui-1,Fe-Ui-Aa!2345,界面甲,,member\n';
  const el = dom.byId('nu-file');
  assert.ok(el, '前置：面板渲染出了文件输入');
  el.files = [{ name: 'accounts.csv', size: 80, arrayBuffer: async () => new TextEncoder().encode(csvText) }];
  el.value = 'C:\\fakepath\\accounts.csv';
  // 走真实的 change 委托链路（40-delegate.js）：这才能证明 HTML 里的
  // data-change 就是"选完文件真的会去导入"的原因，而不是写了个没接线的属性。
  dom.state.listeners['document:change']({ target: fakeEl({ 'data-change': 'usersCsvChosen' }) });
  await settle(calls);
  assert.ok(sent, '应真的 POST 导入接口');
  assert.equal(sent.csv, csvText, 'POST body 应是**解码后的文本**（服务端不收字节、不收 multipart）');
  const dlgHtml = await answer(sandbox, dom);   // 报表弹层；ok 按钮关闭
  assert.ok(/共 3 行：成功 2 个、失败 1 个/.test(dlgHtml), '弹层要先给总数，实际：'
    + dlgHtml.replace(/\s+/g, ' ').slice(-400));
  assert.ok(/第 4 行/.test(dlgHtml) && /admin/.test(dlgHtml) && /已存在/.test(dlgHtml),
    '失败行要带**物理行号** + 账号名 + 原因（用户要回 Excel 里定位）');
  assert.ok(/不会重复创建/.test(dlgHtml), '要写明"修好重导"的语义（已创建的行按已存在逐行拒绝）');
  assert.ok(!/Fe-Imp-Aa!2345|Fe-Imp-Cc!2345/.test(dlgHtml), '报表不得回显任何口令');
  assert.ok(/导入完成/.test(dom.state.html), '页面还要留下一条可见的成功反馈');
});

await t('账号页：超过 512KB 的文件在本地先拦（不发请求、不读内容），提示拆批', async () => {
  const { dom, calls } = await openGovPage('#/users');
  const before = calls.length;
  let read = false;
  const el = dom.byId('nu-file');
  el.files = [{
    name: 'big.csv', size: 512 * 1024 + 1,
    arrayBuffer: async () => { read = true; return new ArrayBuffer(0); },
  }];
  el.value = 'C:\\fakepath\\big.csv';
  dom.state.listeners['document:change']({ target: fakeEl({ 'data-change': 'usersCsvChosen' }) });
  await settle(calls);
  // 本地判定只是为了不让用户白等一次上传 —— 服务端仍会独立拒绝（最终以服务端为准）
  assert.equal(calls.length, before, '本地就能判定超限，不该发任何请求（更不该白传一次）');
  assert.equal(read, false, '超限文件不得再去读内容');
  assert.ok(/过大/.test(dom.state.html) && /512KB/.test(dom.state.html),
    '要有明确的人话提示，实际：' + dom.state.html.replace(/\s+/g, ' ').slice(0, 300));
});

await t('账号页：批量导入入口随 user:write 收敛（只读账号连隐藏的文件输入都看不到）', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  perms.user.write = false;
  const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: perms });
  await sandbox.window.App.login();
  await settle(calls);
  dom.window.location.hash = '#/users';
  dom.state.listeners['window:hashchange']();
  const html = dom.state.html;
  assert.ok(/没有修改权限/.test(html), '前置：只读账号应看到"没有修改权限"提示');
  assert.ok(!/批量导入账号/.test(html), '没有 user:write 不该出现批量导入面板');
  assert.ok(!/data-act="importUsers"/.test(html), '不该出现导入按钮');
  // 按钮不渲染还不够：DOM 里留着一个能改数据的文件输入，等于把入口换个地方放
  assert.ok(!/id="nu-file"/.test(html), '连隐藏的文件输入都不该渲染');
});

await t('组页动作：建组 / 改角色 / 改成员 / 删组都真的打到了接口', async () => {
  const gid = globalThis.__groupId;
  const { dom, sandbox, calls } = await openGovPage('#/groups');

  // 建组：读输入框 → POST
  dom.byId('ng-name').value = '动作探针组';
  dom.byId('ng-desc').value = '用例建的';
  await sandbox.window.App.createGroup();
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/identity/groups'), '建组应真的 POST');
  assert.ok(/已创建/.test(dom.state.html), '建组后要有可见反馈');

  // 改角色：弹层里是**勾选**角色（不是让人输入 role key）。勾第 1 个。
  const roleList = routes['GET /api/identity/roles'].body.roles;
  const p1 = sandbox.window.App.editGroupRoles(gid);
  const roleHtml = await answer(sandbox, dom, { pick: [1] });
  await p1;
  await settle(calls);
  assert.ok(calls.some((c) => c === 'PUT /api/identity/groups/' + gid + '/roles'), '改角色应真的 PUT');
  assert.ok(roleHtml.includes(roleList[1].name), '角色应以**中文名**出现在弹层里（让人认 role key 是把实现推给用户）');

  // 改成员：弹层里是**账号列表**。勾第 1 个。
  const userList = routes['GET /api/identity/users'].body.users;
  const p2 = sandbox.window.App.editGroupMembers(gid);
  const memberHtml = await answer(sandbox, dom, { pick: [1] });
  await p2;
  await settle(calls);
  assert.ok(calls.some((c) => c === 'PUT /api/identity/groups/' + gid + '/members'), '改成员应真的 PUT');
  assert.ok(memberHtml.includes((userList[1] || userList[0]).username), '账号应以**下拉/勾选**形式出现，实际：'
    + memberHtml.replace(/\s+/g, ' ').slice(-400));

  // 删组：要过确认弹层
  const p3 = sandbox.window.App.deleteGroup(gid);
  await answer(sandbox, dom);
  await p3;
  await settle(calls);
  assert.ok(calls.some((c) => c === 'DELETE /api/identity/groups/' + gid), '删组应真的 DELETE');
  assert.ok(/已删除/.test(dom.state.html), '删组后要有可见反馈');
});

await t('组页：改名 / 改说明有界面入口，走弹层、预填原值、真的 PUT、可取消', async () => {
  const gid = globalThis.__groupId;
  const putKey = 'PUT /api/identity/groups/' + gid;
  const putBodies = [];
  const overrides = {};
  // 在真实录到的响应上挂 onCall，把**请求体**录下来 —— 断言"发对了字段"，
  // 而不只是"发过请求"。
  overrides[putKey] = Object.assign({}, routes[putKey], {
    onCall: (opts) => putBodies.push(JSON.parse(opts.body || '{}')),
  });
  const { dom, sandbox, calls } = await openGovPage('#/groups', overrides);

  assert.ok(dom.state.html.includes('data-act="renameGroup" data-a1="' + gid + '"'), '组行应渲染「改名」按钮');
  assert.ok(dom.state.html.includes('data-act="editGroupDesc" data-a1="' + gid + '"'), '组行应渲染「改说明」按钮');

  // 改名：弹层要预填**当前组名**（在原名上改，而不是面对空框重打）
  const p1 = sandbox.window.App.renameGroup(gid);
  const nameHtml = await answer(sandbox, dom, { value: '前端回归组（新）' });
  await p1;
  await settle(calls);
  assert.ok(/id="dlg-input"[^>]*value="前端回归组"/.test(nameHtml),
    '改名弹层应预填当前组名，实际：' + nameHtml.replace(/\s+/g, ' ').slice(0, 300));
  assert.deepEqual(putBodies, [{ name: '前端回归组（新）' }], '改名应只 PUT name 字段');
  assert.ok(/已改名/.test(dom.state.html), '改名后要有可见反馈');

  // 改说明：预填当前说明
  const p2 = sandbox.window.App.editGroupDesc(gid);
  const descHtml = await answer(sandbox, dom, { value: '说明改成这样' });
  await p2;
  await settle(calls);
  assert.ok(/id="dlg-input"[^>]*value="由 test-frontend 录制"/.test(descHtml),
    '改说明弹层应预填当前说明，实际：' + descHtml.replace(/\s+/g, ' ').slice(0, 300));
  assert.deepEqual(putBodies[1], { description: '说明改成这样' }, '改说明应只 PUT description 字段');

  // 清空说明：空串是**有效值** —— 必须真的发出去，不能被当成"取消"
  const p3 = sandbox.window.App.editGroupDesc(gid);
  await answer(sandbox, dom, { value: '' });
  await p3;
  await settle(calls);
  assert.deepEqual(putBodies[2], { description: '' }, '清空说明要真的 PUT（空串 ≠ 取消）');
  assert.ok(/已清空/.test(dom.state.html), '清空后要有明确反馈');

  // 取消：什么都不做、一个请求都不发
  const before = calls.length;
  const p4 = sandbox.window.App.renameGroup(gid);
  await answer(sandbox, dom, { cancel: true });
  await p4;
  await settle(calls);
  assert.equal(calls.length, before, '取消不该发任何请求');
});

await t('组页权限收敛：无 group:write 时看得到组列表，却看不到改名/改说明按钮', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  assert.ok(perms.group, '前置：owner 的权限矩阵应显式含 group 资源（否则本用例测不到东西）');
  perms.group.read = true;
  perms.group.write = false;
  const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: perms });
  await sandbox.window.App.login();
  await settle(calls);
  dom.window.location.hash = '#/groups';
  dom.state.listeners['window:hashchange']();
  const html = dom.state.html;
  assert.ok(/前端回归组/.test(html), '前置：组列表仍应渲染（read 还在）');
  assert.ok(!/data-act="renameGroup"/.test(html), '无 group:write 不该出现改名按钮');
  assert.ok(!/data-act="editGroupDesc"/.test(html), '无 group:write 不该出现改说明按钮');
});

await t('组页：改成员只能从**真实账号列表**里选 —— "选到不存在的账号"这种错在结构上就不存在', async () => {
  const gid = globalThis.__groupId;
  const { dom, sandbox, calls } = await openGovPage('#/groups');
  const users = routes['GET /api/identity/users'].body.users;
  const p = sandbox.window.App.editGroupMembers(gid);
  const html = await answer(sandbox, dom, { cancel: true });
  await p;
  await settle(calls);
  // 每个账号一个 `dlg-opt-<i>`；且**没有**自由文本输入框。
  const opts = (html.match(/id="dlg-opt-/g) || []).length;
  assert.equal(opts, users.length, '选项数应等于账号数（每账号一项），实际 ' + opts);
  assert.ok(!/id="dlg-input"/.test(html),
    '改成员不该出现自由输入框 —— 旧版就是靠它让人手输账号，输错一个名字整条请求被拒');
});

await t('组页权限收敛：无 group:read 时侧栏无入口，也不请求组接口', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  assert.ok(perms.group, '前置：owner 的权限矩阵应显式含 group 资源（否则本用例测不到东西）');
  perms.group.read = false;
  const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: perms });
  await sandbox.window.App.login();
  await settle(calls);
  assert.ok(!/#\/groups/.test(dom.state.html), '无 group:read 不应出现组入口');
  assert.ok(!calls.some((c) => c.includes('/api/identity/groups')), '不应请求组接口');
});

/* ── 两步验证（TOTP，0.17.0）────────────────────────────────────────
   这一节盯的是"第二因子真的是一道门"：口令步只回票据、不发会话；票据 + 动态码/恢复码
   才换得到会话；码错了原地重试而不是把人踢回第一步；自助面板三种状态各有明确的下一步；
   管理员重置只清第二因子。回放数据全部来自本文件前面的「两步验证录制」块 ——
   响应形状 = 真实服务的形状。 */

section('两步验证：登录两阶段与恢复码（回放真实登录链）');

/**
 * 驱动"两步登录"：口令步回一次性票据（overrides 换掉 login），第二因子步按用例
 * 给响应，me 按 flow.verified 在 401/200 之间切换 —— 与服务端真实语义一致
 * （票据没有换成会话之前，/me 确实读不到东西）。
 *
 * `totp` 传对象就是固定的响应条目；传工厂 `(flow) => entry` 可以让条目自己
 * 按调用次数决定回应（错码 → 重试 的用例正是靠它）。
 * 默认条目在 onCall 里把 flow.verified 翻真，并把请求体存进 flow.totpRequest。
 * ⚠️ 副作用只能放 onCall：makeFetch 对 entry.status 读两次（ok 与 status 各一次），
 *    写在 status getter 里会执行两遍。
 */
async function runMfaLogin({ totp = null } = {}) {
  const flow = { verified: false, totpRequest: null };
  const totpEntry = typeof totp === 'function' ? totp(flow) : (totp || {
    status: 200,
    body: routes['POST /api/identity/login/totp#ok'].body,
    onCall: (opts) => {
      flow.verified = true;
      try { flow.totpRequest = JSON.parse(opts.body || '{}'); } catch { flow.totpRequest = null; }
    },
  });
  const { dom, sandbox, calls, rejections } = await runApp({ needsSetup: false, overrides: {
    'POST /api/identity/login': { status: 200, body: routes['POST /api/identity/login#mfa'].body },
    'POST /api/identity/login/totp': totpEntry,
    'GET /api/identity/me': {
      get status() { return flow.verified ? 200 : routes['GET /api/identity/me#anon'].status; },
      get body() { return flow.verified ? meBody : routes['GET /api/identity/me#anon'].body; },
    },
  } });
  return { dom, sandbox, calls, rejections, flow };
}

/** 在 runMfaLogin 的登录页上填账号/口令并提交口令步（不 await 第二因子）。 */
async function submitMfaPassword(sandbox, dom, calls) {
  dom.byId('loginUser').value = MFA_USER;
  dom.byId('loginPass').value = MFA_PASS;
  await sandbox.window.App.login();
  await settle(calls);
}

await t('两步登录·阶段二：口令通过只回票据 —— 页面给验证码入口，不拉身份、不发第二因子请求', async () => {
  const { dom, sandbox, calls, flow } = await runMfaLogin();
  await submitMfaPassword(sandbox, dom, calls);
  const html = dom.state.html;
  assert.ok(/<h1>登录<\/h1>/.test(html), '仍在登录页（第二因子还没过，不能进应用）');
  assert.ok(/id="loginTotpCode"/.test(html) && /验证并登录/.test(html) && /返回上一步/.test(html),
    '应有验证码输入 + 验证并登录 + 返回上一步');
  assert.ok(!/id="loginUser"/.test(html), '第二阶段不该再显示账号输入框');
  assert.ok(html.includes('丢了设备也可以用一张一次性恢复码（XXXX-XXXX）'), '要告诉用户恢复码这条路');
  assert.ok(/口令已通过，只差第二因子/.test(html), '要把当前进度说清楚');
  assert.ok(html.includes(routes['POST /api/identity/login#mfa'].body.note), '服务端的说明要原样带给用户');
  assert.ok(!html.includes(MFA_USER), '第二阶段刻意不回显账号名（票据不绑定给它看的页面）');
  assert.equal(calls.filter((c) => c === 'POST /api/identity/login').length, 1, '口令步只发一次');
  assert.ok(!calls.some((c) => c === 'POST /api/identity/login/totp'), '还没提交验证码');
  assert.equal(calls.filter((c) => c === 'GET /api/identity/me').length, 1,
    '票据阶段不能拉 /me（此刻没有会话，拉了也只能是 401）—— 那一次是 boot 探登录态');
  assert.equal(flow.verified, false, '前置：/me 仍按未认证返回');
  assert.equal(typeof dom.state.listeners['loginTotpCode:keydown'], 'function',
    '回车提交要绑上（与 loginPass 同一套绑定）');
});

await t('两步登录·阶段二：回车提交动态码 → 换到会话进入应用；票据与码原样透传', async () => {
  const { dom, sandbox, calls, flow } = await runMfaLogin();
  await submitMfaPassword(sandbox, dom, calls);
  dom.byId('loginTotpCode').value = '246810';
  dom.state.listeners['loginTotpCode:keydown']({ key: 'Enter', preventDefault() {} });
  await settle(calls);
  assert.equal(flow.verified, true, '第二因子过了');
  assert.ok(flow.totpRequest, '应真的发出了第二因子请求');
  assert.equal(flow.totpRequest.ticket, routes['POST /api/identity/login#mfa'].body.ticket,
    'post 的票据必须就是口令步的那张（透传，不能是别的）');
  assert.equal(flow.totpRequest.code, '246810', '输入的码要原样透传');
  const html = dom.state.html;
  assert.ok(/知识库与检索/.test(html), '应进入应用视图（侧栏出现）');
  assert.ok(!/<h1>登录<\/h1>/.test(html), '登录页应被替换掉');
});

await t('两步登录·阶段二：错码被拒 → 留在原地并说清原因；再输一次可以过', async () => {
  let seen = 0;
  const { dom, sandbox, calls, flow } = await runMfaLogin({
    totp: (flow2) => ({
      onCall: () => { seen += 1; if (seen === 2) flow2.verified = true; },
      get status() { return seen === 2 ? routes['POST /api/identity/login/totp#ok'].status : routes['POST /api/identity/login/totp#bad'].status; },
      get body() { return seen === 2 ? routes['POST /api/identity/login/totp#ok'].body : routes['POST /api/identity/login/totp#bad'].body; },
    }),
  });
  await submitMfaPassword(sandbox, dom, calls);
  dom.byId('loginTotpCode').value = '000000';
  await sandbox.window.App.loginTotp();
  await settle(calls);
  assert.equal(seen, 1, '第一次码应真的发出去');
  assert.equal(flow.verified, false);
  const html = dom.state.html;
  assert.ok(/验证码不正确、已用过，或票据已过期。/.test(html), '401 要给一句能行动的话');
  assert.ok(/id="loginTotpCode"/.test(html) && /返回上一步/.test(html), '要留在第二阶段（不能把人踢回第一步）');
  dom.byId('loginTotpCode').value = '654321';
  await sandbox.window.App.loginTotp();
  await settle(calls);
  assert.equal(seen, 2, '重试要真的再发一次');
  assert.equal(flow.verified, true);
  assert.ok(/知识库与检索/.test(dom.state.html), '这次应进入应用');
});

await t('两步登录·阶段二：点「返回上一步」回账号/口令步 —— 本地动作，零请求', async () => {
  const { dom, sandbox, calls, flow } = await runMfaLogin();
  await submitMfaPassword(sandbox, dom, calls);
  const before = calls.length;
  dom.state.listeners['document:click']({ target: fakeEl({ 'data-act': 'cancelMfa' }), preventDefault() {} });
  const html = dom.state.html;
  assert.equal(calls.length, before, '取消是本地动作：不该发任何请求');
  assert.ok(/id="loginUser"/.test(html) && /id="loginPass"/.test(html), '应回到账号/口令步');
  assert.ok(!/id="loginTotpCode"/.test(html), '第二阶段入口应消失');
  assert.equal(flow.verified, false);
});

await t('两步登录·阶段二：用一次性恢复码登录 —— 剩余张数当场报出，并引导去重新生成', async () => {
  const { dom, sandbox, calls } = await runMfaLogin({
    totp: (flow) => ({
      status: 200,
      body: routes['POST /api/identity/login/totp#recovery'].body,
      onCall: () => { flow.verified = true; },
    }),
  });
  await submitMfaPassword(sandbox, dom, calls);
  dom.byId('loginTotpCode').value = mfaRecoveryCodes[0];
  await sandbox.window.App.loginTotp();
  await settle(calls);
  const html = dom.state.html;
  assert.ok(/已用一张恢复码完成登录（剩余 9 张，每张只能用一次）/.test(html),
    '烧掉的恢复码要当场说清（否则用户以为恢复码还是满的），实际：' + html.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(/建议到「我的账号」重新生成一批/.test(html), '要给出下一步行动');
  assert.ok(/知识库与检索/.test(html), '应进入应用视图');
});

section('两步验证：自助面板与管理员重置（「我的账号」/ 账号页）');

await t('我的账号：两步验证状态读不到 —— 如实说明并让用户重试，不假装"未启用"', async () => {
  const { dom } = await openGovPage('#/me', {
    'GET /api/identity/totp': { status: 500, body: { ok: false, error: { code: 'boom', message: '坏掉了' } } },
  });
  const html = dom.state.html;
  assert.ok(/读不到两步验证状态/.test(html), '要把"读不到"与"没启用"分开说（处置完全不同）');
  assert.ok(!/当前未启用/.test(html), '不应误渲染成"未启用"（那会诱使管理员去点开启）');
  assert.ok(!/data-act="totpBeginEnroll"/.test(html), '读不到状态时不给任何动作入口');
});

await t('我的账号：未完成登记 —— 给「继续确认 / 换新密钥重来」两条路，不给停用/重发恢复码', async () => {
  const { dom } = await openGovPage('#/me', {
    'GET /api/identity/totp': routes['GET /api/identity/totp#pending'],
  });
  const html = dom.state.html;
  assert.ok(/未完成登记/.test(html), '要如实显示"待确认"（确认前不生效）');
  assert.ok(/密钥已生成、但还没用动态码确认/.test(html));
  assert.ok(/data-act="totpConfirm"/.test(html) && /继续确认/.test(html));
  assert.ok(/data-act="totpBeginEnroll"/.test(html) && /重新登记（换新密钥）/.test(html));
  assert.ok(!/data-act="totpDisable"/.test(html), '还没启用就谈不上停用');
  assert.ok(!/data-act="totpRegenCodes"/.test(html), '还没启用就没有恢复码可重发');
});

await t('我的账号：已启用 —— 显示启用时间与剩余恢复码；按钮形状精确（>3 张不催）', async () => {
  const { dom } = await openGovPage('#/me', {
    'GET /api/identity/totp': routes['GET /api/identity/totp#enabled'],
  });
  const html = dom.state.html;
  assert.ok(/已启用/.test(html) && /恢复码剩余：10 张/.test(html), '要有"剩几张"这个当下可行动的数字');
  assert.ok(/启用时间：/.test(html));
  assert.ok(/<button\s+data-act="totpRegenCodes">重新生成恢复码<\/button>/.test(html),
    '>3 张时不加 primary（不该天天催）');
  assert.ok(/<button class="danger"\s+data-act="totpDisable">停用<\/button>/.test(html));
  assert.ok(!/恢复机会不多了/.test(html), '码还多时不该催');
});

await t('我的账号：恢复码只剩 2 张 —— 面板主动催，并把「重新生成」提成主按钮', async () => {
  const low = JSON.parse(JSON.stringify(routes['GET /api/identity/totp#enabled'].body));
  low.totp.recoveryCodesLeft = 2;
  const { dom } = await openGovPage('#/me', { 'GET /api/identity/totp': { status: 200, body: low } });
  const html = dom.state.html;
  assert.ok(/恢复码只剩 2 张/.test(html) && /建议现在重新生成一批/.test(html), '低码要主动催（丢设备时才想起就晚了）');
  assert.ok(/<button class="primary"\s+data-act="totpRegenCodes">/.test(html),
    '≤3 张时"重新生成"应升为主按钮');
});

await t('我的账号：自助开启两步验证 —— 口令 → 出密钥 → 录错码不关窗 → 确认后一次性亮恢复码', async () => {
  let phase = 'off';
  let confirmReq = null;
  const { dom, sandbox, calls } = await openGovPage('#/me', {
    'GET /api/identity/totp': {
      get status() { return 200; },
      get body() { return phase === 'enabled' ? routes['GET /api/identity/totp#enabled'].body : routes['GET /api/identity/totp'].body; },
    },
    'POST /api/identity/totp/enroll': routes['POST /api/identity/totp/enroll'],
    'POST /api/identity/totp/confirm': {
      status: 200, body: routes['POST /api/identity/totp/confirm'].body,
      onCall: (opts) => { confirmReq = JSON.parse(opts.body || '{}'); phase = 'enabled'; },
    },
  });
  assert.ok(/当前未启用/.test(dom.state.html), '前置：自助面板应显示未启用');
  assert.ok(/<button class="primary"\s+data-act="totpBeginEnroll">开启两步验证<\/button>/.test(dom.state.html),
    '未启用面板的开启按钮应是 primary 主按钮');

  const p = sandbox.window.App.totpBeginEnroll();
  const pwSnap = await answer(sandbox, dom, { value: MFA_PASS });
  assert.ok(/先确认是你本人/.test(pwSnap), '登记前要重输口令（现场凭证）');
  assert.ok(/id="dlg-input" type="password"/.test(pwSnap), '口令栏必须遮蔽');
  await settle(calls);
  const enrollSnap = await answer(sandbox, dom);   // 「登记验证器」通知
  assert.ok(calls.some((c) => c === 'POST /api/identity/totp/enroll'), '应真的调登记接口');
  assert.ok(enrollSnap.includes(mfaSecret1), '密钥要亮出来（这是它唯一一次出现）');
  assert.ok(/otpauth:\/\/totp\//.test(enrollSnap), '要给可扫码/手录的 otpauth URI');
  assert.ok(/id="dlg-mono"/.test(enrollSnap), '密钥放在只读文本域里（关掉还能复制）');
  assert.ok(/不要截图/.test(enrollSnap), '要把"这是第二因子的根"的风险讲清楚');
  await settle(calls);
  await answer(sandbox, dom, { value: '123' });    // 录错格式
  const afterBad = dom.state.html;
  assert.ok(/modal-wrap dlg/.test(afterBad), '校验没过不该关窗');
  assert.ok(afterBad.includes('请输入 6 位数字（App 上每 30 秒换一次）'), '要说清格式要求');
  assert.ok(!calls.some((c) => c === 'POST /api/identity/totp/confirm'), '校验没过不发请求');
  const codesSnap = await answer(sandbox, dom, { value: '123456' });
  assert.ok(/输入验证器 App 上现在显示的 6 位动态码/.test(codesSnap));
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/identity/totp/confirm'), '确认应真的 POST');
  assert.equal(confirmReq.code, '123456', '动态码要透传');
  const codesSnap2 = await answer(sandbox, dom);   // 「两步验证已开启」恢复码弹层
  assert.ok(mfaRecoveryCodes.every((c) => codesSnap2.includes(c)), '10 张恢复码要一次性全部亮出');
  assert.ok(/10 张一次性恢复码/.test(codesSnap2));
  assert.ok(/恢复码只显示这一次/.test(codesSnap2), '"只显示一次"必须写在弹层里');
  // 有界切片：codesSnap2 是**整页**快照，dlg-actions 之后还跟着弹层收尾。
  // 不切到弹层末尾会把后面那些按钮一起数进来，误报"第二条路"。
  // 弹层尾部固定是 `</div>`(actions) + `</div></div>`(modal+wrap)，故首个 `</div></div>` 即边界。
  const tail = codesSnap2.slice(codesSnap2.indexOf('dlg-actions'));
  const actions = tail.slice(0, tail.indexOf('</div></div>'));
  assert.equal((actions.match(/<button/g) || []).length, 1,
    'notice 只能确认，没有第二条路（实际：' + actions.replace(/\s+/g, ' ') + '）');
  await p;
  await settle(calls);
  assert.ok(/两步验证已开启（恢复码只显示过这一次，请确认已保存）。/.test(dom.state.html), '要有可见反馈');
  assert.ok(/已启用/.test(dom.state.html) && /恢复码剩余：10 张/.test(dom.state.html), '面板要刷新成已启用');
});

await t('我的账号：停用是安全降级 —— 口令 + 动态码双证；取消不发任何请求', async () => {
  let phase = 'enabled';
  let disableReq = null;
  const { dom, sandbox, calls } = await openGovPage('#/me', {
    'GET /api/identity/totp': {
      get status() { return 200; },
      get body() { return phase === 'enabled' ? routes['GET /api/identity/totp#enabled'].body : routes['GET /api/identity/totp'].body; },
    },
    'POST /api/identity/totp/disable': {
      status: 200, body: routes['POST /api/identity/totp/disable'].body,
      onCall: (opts) => { disableReq = JSON.parse(opts.body || '{}'); phase = 'disabled'; },
    },
  });
  assert.ok(/已启用/.test(dom.state.html), '前置：面板应显示已启用');

  const before = calls.length;
  const p0 = sandbox.window.App.totpDisable();
  await answer(sandbox, dom, { cancel: true });
  await p0;
  assert.equal(calls.length, before, '取消停用不该发出任何请求');

  const p = sandbox.window.App.totpDisable();
  const pwSnap = await answer(sandbox, dom, { value: MFA_PASS });
  assert.ok(/停用是安全降级/.test(pwSnap), '要把"为什么还要再验一次"讲清楚');
  assert.ok(/id="dlg-input" type="password"/.test(pwSnap), '口令栏必须遮蔽');
  await settle(calls);
  const codeSnap = await answer(sandbox, dom, { value: '246810' });
  assert.ok(/再输入验证器上当前的 6 位动态码/.test(codeSnap));
  assert.ok(/id="dlg-ok" class="danger"/.test(codeSnap), '停用按钮应标 danger（破坏性降级）');
  await p;
  await settle(calls);
  assert.ok(disableReq, '应真的发出停用请求');
  assert.equal(disableReq.password, MFA_PASS, '口令要透传');
  assert.ok(/^\d{6}$/.test(disableReq.code), '动态码要透传');
  assert.ok(/两步验证已停用（恢复码一并作废）/.test(dom.state.html), '要有可见反馈');
  assert.ok(/当前未启用/.test(dom.state.html), '面板要随数据刷新回未启用态');
});

await t('账号页：管理员重置两步验证 —— 只清第二因子；面板随数据刷新（按钮数减一可自证）', async () => {
  let resetDone = false;
  const fixture = routes['GET /api/identity/users#has-mfa'].body;
  const withTotp = fixture.users.filter((u) => u.totpEnabled);
  assert.ok(withTotp.length >= 1, '前置：录制快照里应有已启用两步的账号');
  const { dom, sandbox, calls } = await openGovPage('#/users', {
    'GET /api/identity/users': {
      get status() { return 200; },
      get body() {
        const b = routes['GET /api/identity/users#has-mfa'].body;
        if (!resetDone) return b;
        const copy = JSON.parse(JSON.stringify(b));
        const row = copy.users.find((u) => u.id === mfaUserId);
        if (row) row.totpEnabled = false;
        return copy;
      },
    },
    ['POST /api/identity/users/' + mfaUserId + '/totp-reset']: {
      status: 200, body: routes['POST /api/identity/users/' + mfaUserId + '/totp-reset'].body,
      onCall: () => { resetDone = true; },
    },
  });
  const count = () => (dom.state.html.match(/data-act="resetUserTotp"/g) || []).length;
  assert.ok(dom.state.html.includes('title="已启用两步验证（TOTP）"'), '已启用账号要有「两步」徽标');
  assert.equal(count(), withTotp.length, '每个已启用账号一行「重置两步验证」按钮');

  const p = sandbox.window.App.resetUserTotp(mfaUserId, MFA_USER);
  const dlgHtml = await answer(sandbox, dom);
  assert.ok(dlgHtml.includes('重置 ' + MFA_USER + ' 的两步验证？'), '确认文案要点名账号');
  assert.ok(/口令不变、现有会话不受影响/.test(dlgHtml), '要把"轻处置"的边界写清楚（否则管理员不敢用）');
  assert.ok(/需要重新登记一台验证器/.test(dlgHtml), '要说明用户的下一步');
  await p;
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/identity/users/' + mfaUserId + '/totp-reset'), '应真的发重置请求');
  assert.ok(dom.state.html.includes(MFA_USER + ' 的两步验证已重置'), '要有可见反馈');
  assert.ok(/清掉恢复码 10 张/.test(dom.state.html), '把清掉的东西报出来');
  assert.equal(count(), withTotp.length - 1, '重置后按钮应少一个（面板随数据刷新）');
});

/* ── 应用内对话框（0.15.0 取代原生 prompt / confirm / alert）──────────────
   这一节盯的**不是**"弹层好不好看"，而是三件用原生弹窗做不到、做不好、或做错了的事：
     ① 取消与"选了空值"必须分得开（否则"点拒绝 → 按取消"会变成"以空原因把单子拒了"；
        这正是改之前真实存在的一处 bug）；
     ② 收口令的输入框必须遮蔽（原生 prompt 是明文）；
     ③ 选项必须是**渲染出来的**（账号、部门、角色），不能让人照着提示手敲标识符。 */

section('应用内对话框：取消语义 / 校验 / 口令遮蔽 / 选项即数据');

/* ── 逐路由渲染：每一页都真的渲染得出来 ─────────────────────── */

// 从路由表源码提取（id + group + title + hash）—— 不硬编码清单，
// 将来新增/移动路由自动被本用例覆盖（group 也要抓：路由归位断言依赖它）。
const ALL_ROUTES = (() => {
  const src = readAppParts().find(([f]) => f === '10-routes.js')[1];
  const list = [];
  for (const line of src.split('\n')) {
    const m = line.match(/id: '([a-zA-Z]+)'.*?group: '([^']+)'.*?title: '([^']+)'.*?hash: '(#\/[\w]+)'/);
    if (m) list.push({ id: m[1], group: m[2], title: m[3], hash: m[4] });
  }
  return list;
})();

await t(`逐路由渲染：全部 ${ALL_ROUTES.length} 页都能渲染、标题正确、不触发错误边界`, async () => {
  // 为什么必须有：pageContract 曾因「后端 compat 段改成了四态字段、前端还在按旧名读」
  // 抛 TypeError —— render() 是"先算 body 再写 innerHTML"，异常一抛 innerHTML 就不执行，
  // hash 变了、画面不动，症状就是用户说的"点侧栏没反应"。
  // 逐页渲染 + **真实回放数据**（接口形状 = 真实形状），这类前后端字段脱节当场现形。
  const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: meBody.permissions });
  await sandbox.window.App.login();       // boot 后 view=login，必须真的登录才进 app 视图
  await settle(calls);
  const fire = () => dom.state.listeners['window:hashchange']();
  const problems = [];
  let overviewHtml = '';
  for (const r of ALL_ROUTES) {
    dom.window.location.hash = r.hash;
    fire();
    await settle(calls);
    const html = dom.state.html;
    if (r.id === 'overview') overviewHtml = html;
    // 0.21.2 起工作台是**全屏视图**（没有页标题 h1，也不套管理外壳）——
    // 它的"渲染成功"判据是输入卡在，而不是标题在。
    if (r.id === 'workbench') {
      if (!html.includes('id="wb-input"')) problems.push(r.hash + ' 工作台未渲染（全屏视图应有输入卡）');
    } else if (!html.includes('>' + r.title + '</h1>')) {
      problems.push(r.hash + ' 标题未渲染（页面可能根本没切过去）');
      continue;
    }
    if (html.includes('本页渲染失败')) problems.push(r.hash + ' 触发了渲染错误边界');
    if (html.includes('正在读取…')) problems.push(r.hash + ' 回放数据齐全却仍卡在加载态');
  }
  assert.ok(ALL_ROUTES.length >= 21,
    '路由表应解析出 21+ 页，实际 ' + ALL_ROUTES.length + '（提取正则跟不上路由表格式了？）');
  assert.equal(problems.length, 0, problems.join('；') || '全部通过');

  // 合并页钉子（0.15.5）：系统状态并入概览后，四块明细一块都不能少。
  // 「会话与回合」页已整体删除：日常对话与管理（改名/删除）都在工作台，
  // 事件级回放由工作台侧栏"上下文"承接 —— 这里钉住的是"删了就别再出现在路由表"。
  // 漏掉任一明细 = 合并或回潮时丢了诊断能力，当场报红。
  assert.ok(!ALL_ROUTES.some((r) => r.id === 'system'), '系统状态页应已删除（明细并入概览）');
  assert.ok(!ALL_ROUTES.some((r) => r.id === 'sessions'), '会话与回合页应已删除（日常入口在工作台）');
  for (const want of ['系统明细（诊断用）', '平台信息与配置来源', '数据库与迁移', '前端产物对账', '原始响应 JSON']) {
    assert.ok(overviewHtml.includes(want), '概览合并页缺少明细块：' + want);
  }
});

await t('★ 内核接入弹框：一屏、先检测才能保存、检测通过保存后当场关闭并落到首页', async () => {
  // 用户明确裁定的取舍（0.21.4 起）：内核不可用时**拦住整个平台**，不是"只挡对话"。
  // 理由：一个能看能点、但一发起对话就报错的平台，比一个说清"去配内核"的平台更糟 ——
  // 前者会让人以为功能坏了。
  //
  // 0.21.5 又收敛了一次：这一屏曾经是四五屏的说明文（内核是什么、哪些功能不依赖它、
  // 可核对项表格、保存回执、切换语义的两条须知…），结果"填地址、点检测"这两件事
  // 被埋在解释里。面对这一页的人是**第一次把平台跑起来的管理员**，他手里已经拿着
  // 内核启动打印的那一行 —— 需要的是粘哪儿、点哪个键。所以下面每一条"不许长"的断言
  // 都是在钉那次收敛（它们不是风格洁癖：那些段落加回来，用户就得读四屏才知道要点哪儿）。
  //
  // 状态桩刻意做成**可变**的：检测通过、保存成功后翻成 ready，用来验"弹框能自己关掉"。
  // 若写成恒 false，就会漏掉"接入成功却被永远关在门外"那个真 bug。
  let kernelReady = false;
  let saved = null;
  const okProbe = {
    origin: 'http://127.0.0.1:3099', ok: true, state: 'ok', stage: '就绪',
    verdict: '连上了，令牌有效，内核可用', detail: '外部内核已认证可达',
    hint: '可以保存了：保存即生效，无需重启（正在进行的回合会用切换前的内核跑完）。',
    reachable: true, authed: true, httpStatus: 200, server: 'stub', contentType: 'text/html',
    version: '0.2.0-rc.2', hasToken: true, tokenSource: 'origin',
  };
  const statusBody = () => {
    const b = JSON.parse(JSON.stringify(routes['GET /api/system/status'].body));
    b.kernel = { ready: kernelReady, reason: kernelReady ? '' : '尚未接入内核（配置里没有内核地址）' };
    return b;
  };
  const { dom, sandbox, calls } = await runApp({
    needsSetup: false, permissions: meBody.permissions, loggedIn: true,
    overrides: {
      'GET /api/system/status': { status: 200, get body() { return statusBody(); } },
      'POST /api/system/kernel/probe': { status: 200, body: { probe: okProbe } },
      'POST /api/system/kernel/config': {
        status: 200,
        onCall: (opts) => { saved = JSON.parse(opts.body); kernelReady = true; },
        body: {
          saved: true, file: 'data/config.json', bytes: 128,
          applied: { origin: 'http://127.0.0.1:3099', hasToken: true },
          restartRequired: false, restartNote: '',
          switched: { ready: true, reason: '', note: '已当场生效，无需重启。两点要知道：①…②…' },
        },
      },
    },
  });
  await settle(calls);

  const html = dom.state.html;
  assert.ok(/尚未接入内核/.test(html), '应显示接入弹框');
  assert.ok(/填入内核地址，检测通过后保存即可开始使用/.test(html),
    '一句话说清"要干什么"（不是一段"内核是什么"的科普）');
  assert.ok(!/内核是平台的执行引擎/.test(html), '那段讲平台架构的解释不该出现在弹框上');
  assert.ok(!/id="wb-input"/.test(html), '整页替换：工作台输入卡不该同时在场（否则就是"看起来正常但点不动"）');
  assert.ok(!/data-act="kernelDismiss|\bkg-close\b/.test(html), '不得有"关掉它继续用"的出口');
  assert.ok(!/先用内置内核试用|内置内核/.test(html), '那个"先凑合用"的逃生口应已随内置内核一并删除');
  assert.ok(/data-act="logout"/.test(html), '必须留"退出登录"这条出路，否则用户被困在一个什么都做不了的页面上');

  // ① 没有「跳过检测直接保存」这个控件（0.21.5：保存必须以检测通过为前提）。
  assert.equal(dom.byId('kg-force'), null, '不该再有"跳过检测直接保存"的勾选框');
  assert.ok(!/跳过检测/.test(html), '那个选项的文案也该一并消失');

  // ② 还没检测 → 保存被拦在**本地**，不发请求，而且说人话。
  //    （服务端也拦得住，但让用户白等一次往返、再看一句 409 是最差的一种"也拦住了"。）
  const before = calls.length;
  await sandbox.window.App.kernelSave();
  await settle(calls);
  assert.equal(calls.length, before, '没检测就不该发保存请求');
  assert.ok(!saved, '没检测更不该真的存进去');
  assert.ok(/先点「检测连接」/.test(dom.state.html), '要告诉用户"先去点检测"，而不是静默不动');

  // ③ 输入事件必须真的把值写进 State，并且**改动即作废旧结论**：
  //    否则"先探一个好地址、再改成另一个"就能绕过"必须检测通过才能保存"。
  assert.ok(dom.byId('kg-origin'), '管理员应看到地址输入框');
  const onInput = dom.state.listeners['kg-origin:input'];
  assert.equal(typeof onInput, 'function', '弹框必须绑 input 事件（否则填了地址 State.kernelForm 仍是空的）');
  onInput({ target: { value: 'http://127.0.0.1:3099/?token=abc' } });

  // ④ 检测连接 → 绿色结论。弹框上只要三行（结果 / 一句话原因 / 下一步），
  //    不要"可核对项"那张排查表 —— 那是给正在排查接不通的人用的，在概览页。
  await sandbox.window.App.kernelProbe();
  await settle(calls);
  const probed = dom.state.html;
  assert.ok(/连上了，令牌有效，内核可用/.test(probed), '检测通过要给出绿色结论');
  assert.ok(!/<span>地址 /.test(probed), '弹框上不该出现"可核对项"那张表（地址/HTTP/类型/版本/令牌）');
  assert.ok(!/类型 text\/html/.test(probed), '同上：可核对项里的类型也不该在弹框上');

  // ⑤ 保存并启用 → 真的 POST，且**不带 force**（那条口子已删）。
  await sandbox.window.App.kernelSave();
  await settle(calls);
  assert.ok(saved, '检测通过后应真的把配置 POST 出去');
  // 前端**原样**提交用户粘进来的整段（内嵌令牌由服务端 normalizeKernelInput 摘出）。
  // 这不是"没测"——它钉住的是"前端别自作聪明改写用户填的东西"：
  // 一旦前端也去解析/裁剪地址，用户从内核启动行整段粘过来的令牌就会在两处被不同地解释。
  assert.equal(saved.origin, 'http://127.0.0.1:3099/?token=abc',
    '地址要原样带上（内嵌令牌由服务端摘出，前端不做二次解析）');
  assert.ok(!('force' in saved), '请求体里不该再带 force（0.21.5 删掉了这条旁路）');

  // ⑥ 保存成功 ⇒ 弹框**当场关掉**、落到首页，不需要手动刷新，也不需要用户去关什么。
  //    这一条同时钉两件事：阻断页判的是 `State.status.kernel.ready`，而 kernelSave
  //    从前只刷了 /api/kernel/status（另一个接口）—— 少刷一个，用户就被永远关在门外；
  //    以及"落点 = 落地页"，而不是留在那个已被替换掉的空页上。
  const after = dom.state.html;
  assert.ok(!/尚未接入内核/.test(after), '接入成功后弹框必须自己关掉（否则用户只能刷页面或退出重登）');
  assert.ok(!/id="kg-origin"/.test(after), '关掉之后表单不该还在');
  assert.ok(dom.window.location.hash === sandbox.window.App.currentRoute().hash,
    '落点应当是落地页（defaultRoute），实际 hash=' + dom.window.location.hash);
  assert.ok(!/两点要知道/.test(after), '成功后的那段"切换语义须知"不该再出现在首页上');
  assert.ok(!/<code>data\/config\.json<\/code>/.test(after), '也不该把"已写入哪个文件、多少字节"铺在首页上');
});

await t('★ 内核不可用（配了但连不上）：标题与说明跟着**为什么**走，不许说成"尚未接入"', async () => {
  // 内核只有"能用 / 不能用"两种状态，而"不能用"有两种成因：没配地址 / 配了但连不上。
  // 后者如果说成"尚未接入"，会把人的排查方向带偏 —— 他会去翻配置文件，
  // 而真正的问题在内核进程没起来（或地址填错）。
  const blocked = JSON.parse(JSON.stringify(routes['GET /api/system/status'].body));
  blocked.kernel = { ready: false, reason: '内核已配置但当前不可用（连通：连不上，127.0.0.1:9 没有服务在听）。' };
  const { dom, calls } = await runApp({
    needsSetup: false, permissions: meBody.permissions, loggedIn: true,
    overrides: { 'GET /api/system/status': { status: 200, body: blocked } },
  });
  await settle(calls);
  assert.ok(/内核当前不可用/.test(dom.state.html), '配了却连不上，标题要说"当前不可用"');
  assert.ok(!/尚未接入内核/.test(dom.state.html), '这里说"尚未接入"是句假话');
  assert.ok(/没有服务在听/.test(dom.state.html), '要把"为什么不可用"原样说出来');
});

await t('★ 内核接入弹框：非管理员看到的是"去找管理员"，不是一张填不了的表单', async () => {
  const blocked = JSON.parse(JSON.stringify(routes['GET /api/system/status'].body));
  blocked.kernel = { ready: false, reason: '尚未接入内核（配置里没有内核地址）' };
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  perms.system.write = false;
  const { dom, calls } = await runApp({
    needsSetup: false, permissions: perms, loggedIn: true,
    overrides: { 'GET /api/system/status': { status: 200, body: blocked } },
  });
  await settle(calls);
  const html = dom.state.html;
  assert.ok(/尚未接入内核/.test(html), '成员同样被拦住（拦的是整个平台）');
  // 接入内核是**管理员动作**（服务端会主动连向调用方指定的任意地址，SSRF 形状），
  // 所以这里不但不该有表单，还该明确说"找谁"。
  assert.equal(dom.byId('kg-origin'), null, '非管理员不该看到地址输入框');
  assert.ok(/管理员/.test(html), '要告诉成员该找谁，而不是让他对着一张填不了的表单发呆');
  assert.ok(/data-act="logout"/.test(html), '非管理员也要有出路');
});

await t('弹层：**每个渲染分支**都带上它（漏一个分支 = 那条动作链永远挂住，症状是"点了没反应"）', async () => {
  // 这是从一次真实失败里长出来的钉子：最初只有登录后的分支拼了 dlgOverlay()，
  // 于是 boot/setup/login 三个"全屏视图"里 `Dlg.*` 弹出的东西**根本没被渲染** ——
  // 用户看不到弹层，而等它答复的那个 await 永不 settle。
  // 断言方式：直接读源码里 render 的四个装配点，而不是只测"当前视图能弹出来"——
  // 后者在改动登录分支时会漏检。
  const src = stripComments(readAppParts().find(([f]) => f === '90-start.js')[1]);
  const branches = [
    [/State\.view === 'boot'[\s\S]{0,160}?pageBoot\(\)[\s\S]{0,40}/.exec(src), 'boot'],
    [/State\.view === 'setup'[\s\S]{0,160}?pageSetup\(\)[\s\S]{0,40}/.exec(src), 'setup'],
    [/State\.view === 'login'[\s\S]{0,160}?pageLogin\(\)[\s\S]{0,40}/.exec(src), 'login'],
    // 0.21.4 新增：内核未接入时的**整页阻断**。它是 render 里唯一一个"按服务端状态"提前返回的
    // 分支 —— 也最容易在下次改动时被忘掉（另外三个是看 State.view，一眼能数清）。
    [/!State\.status\.kernel\.ready[\s\S]{0,160}?pageKernelGate\([\s\S]{0,60}/.exec(src), 'kernelGate'],
  ];
  for (const [m, name] of branches) {
    assert.ok(m, '没找到 ' + name + ' 分支的页面装配（render 结构变了？）');
    assert.ok(/dlgOverlay\(\)/.test(m[0]), name + ' 分支必须也拼上 dlgOverlay()');
  }
  // 登录后的那一支（正常页面）。body 的计算包在 IIFE 错误边界里
  // （单页崩不能拖死整站），所以这里锚 pageMap 而不是 `const body`。
  const app = /pageMap\[cur\.id\][\s\S]{0,900}?dlgOverlay\(\)/.exec(src);
  assert.ok(app, '没找到登录后分支的页面装配');

  // 阻断页的自洽性（源码层）：弹层必须拼在**阻断页之后**（弹层要压在最上面），
  // 且必须真的把表单输入绑上 —— 它的全部意义就是"在这儿把内核配上"，
  // 绑漏了症状是"填了地址点保存没反应"（因为 State.kernelForm 一直是空的）。
  const gate = /pageKernelGate\([\s\S]{0,240}?dlgOverlay\(\)/.exec(src);
  assert.ok(gate, '没找到未接入内核阻断页的页面装配（render 结构变了？）');
  assert.ok(gate[0].indexOf('pageKernelGate(') < gate[0].indexOf('dlgOverlay()'),
    '顺序：先阻断页、后弹层');
  assert.ok(/bindKernelFormInputs\('kg'\)/.test(src),
    '阻断页必须绑表单输入（用 kg 前缀），否则"填了地址保存不上"');

  // 行为侧再验一遍：**未登录**视图里弹层也得真的渲染出来
  const { dom, sandbox } = await runApp({ needsSetup: false });
  const p = sandbox.window.Dlg.confirm({ title: '登录页也能弹', body: ['B'] });
  const html = await answer(sandbox, dom);
  assert.ok(/modal-wrap dlg/.test(html), '登录视图下弹层也应渲染');
  await p;
});

await t('弹层：确认返回真、取消返回假，两种答案都会把弹层关掉', async () => {
  const { dom, sandbox } = await runApp({ needsSetup: false });
  const a = sandbox.window.Dlg.confirm({ title: 'T', body: ['B'] });
  const html = await answer(sandbox, dom);
  assert.ok(/modal-wrap dlg/.test(html), '应渲染出弹层');
  assert.ok(/dlg-backdrop/.test(html), '应有独立遮罩层（点遮罩即取消）');
  assert.ok(/role="dialog"/.test(html) && /aria-modal="true"/.test(html),
    '弹层要有 dialog 语义（读屏器要能认出这是对话框）');
  assert.equal(await a, true, '点确认应返回真');
  assert.ok(!/modal-wrap dlg/.test(dom.state.html), '确认后弹层要关掉');

  const b = sandbox.window.Dlg.confirm({ title: 'T', body: ['B'] });
  await answer(sandbox, dom, { cancel: true });
  assert.equal(await b, false, '点取消应返回假');
  assert.ok(!/modal-wrap dlg/.test(dom.state.html), '取消后弹层也要关掉');
});

await t('弹层：必填项为空时**留在弹层里**并说清原因，不关窗、不发请求', async () => {
  const { dom, sandbox, calls } = await openGovPage('#/knowledge');
  const before = calls.length;
  const p = sandbox.window.App.renameBase(KB_ID, '原名字');
  await answer(sandbox, dom, { value: '   ' });        // 只输空白
  const after = dom.state.html;
  assert.ok(/modal-wrap dlg/.test(after), '校验没过不该关窗 —— 关掉让人从头再来最气人');
  assert.ok(/不能为空/.test(after), '要说清"为什么没提交"，实际弹层：'
    + after.replace(/\s+/g, ' ').slice(-400));
  // 这时再填一个合法名字，才应该真的走提交
  dom.byId('dlg-input').value = '改过的名字';
  sandbox.window.App.dlgOk();
  await new Promise((r) => setImmediate(r));
  await p;
  await settle(calls);
  assert.ok(!/modal-wrap dlg/.test(dom.state.html), '这次应真的提交并关窗');
  assert.notEqual(calls.length, before, '合法值应发出改名请求');
});

await t('重置口令：输入框是遮蔽的（原生 prompt 会把新口令**明文**摆在屏幕上）', async () => {
  const { dom, sandbox, calls } = await openGovPage('#/users');
  const u = routes['GET /api/identity/users'].body.users[0];
  const before = calls.length;
  const p = sandbox.window.App.resetPassword(u.id);
  const html = await answer(sandbox, dom, { cancel: true });   // 取消 = 不改任何东西
  await p;
  await settle(calls);
  assert.ok(/id="dlg-input" type="password"/.test(html),
    '口令栏必须是 type=password，实际：' + html.replace(/\s+/g, ' ').slice(-400));
  assert.ok(/至少 8 位|含两类/.test(html), '要把口令规则写在弹层里（不是让人去猜）');
  assert.equal(calls.length, before, '取消重置口令不该发出任何请求');
});

await t('一次性明文（API Key）：用只读文本域而不是 alert —— 关掉还能复制，且带"只显示一次"的警告', async () => {
  const { dom, sandbox } = await runApp({ needsSetup: false });
  const n = sandbox.window.Dlg.notice({
    title: 'API Key 已创建',
    body: ['这是「部署脚本」的密钥明文。'],
    mono: 'sti_live_ABCDEF0123456789', monoRows: 3,
    warn: '这个值只显示这一次。',
  });
  const html = await answer(sandbox, dom);
  assert.ok(/id="dlg-mono"/.test(html) && /readonly/.test(html), '明文要放在只读文本域里（alert 关掉就没了）');
  assert.ok(html.includes('sti_live_ABCDEF0123456789'), '明文本身要被显示出来');
  assert.ok(/只显示这一次/.test(html), '必须把"只显示一次"说清楚');
  // notice 是"已知悉"型：动作区**只有一个**按钮，不给一个语义含糊的"取消"
  // （关掉它没有任何后果）。遮罩本身仍可点掉 —— 那与"取消"不是一回事。
  const actions = html.slice(html.indexOf('dlg-actions'));
  assert.equal((actions.match(/<button/g) || []).length, 1,
    'notice 的动作区应只有一个按钮，实际：' + actions.replace(/\s+/g, ' ').slice(0, 200));
  await n;
});

/* ── 模型中心页（P1-1）──────────────────────────────────────── */

section('模型中心页：注册表 / 默认与降级链 / 探活两层结论 / 权限收敛');

await t('模型页：渲染真实条目、默认来源、降级链，并写明"不做请求转发"的边界', async () => {
  const ids = globalThis.__modelIds;
  const { dom } = await openGovPage('#/models');
  const html = dom.state.html;
  assert.ok(/模型中心/.test(html), '应能进入模型中心页');
  assert.ok(/登记模型服务/.test(html), '有写权限时应渲染登记表单');
  // 这条边界必须出现在界面上：否则"模型中心"四个字会被当成"配额已经能事前拦截"
  assert.ok(/不做请求转发/.test(html), '必须写明本模块不是网关（v1.0 才做转发）');

  const list = routes['GET /api/model/providers'].body;
  const chat = list.providers.find((x) => x.id === ids.chat);
  const embed = list.providers.find((x) => x.id === ids.embed);
  assert.ok(chat && embed, '前置：录制期的条目应在列表里');
  assert.ok(html.includes(chat.name), '应渲染真实对话条目名：' + chat.name);
  assert.ok(html.includes(embed.name), '应渲染真实向量条目名：' + embed.name);
  assert.ok(/Anthropic Messages/.test(html), '协议要显示成人能读的名字，而不是裸 key');

  assert.ok(/显式设置/.test(html), '默认来源要如实显示（显式 / 取链首），实际片段：'
    + html.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(/链（\d+ 项）/.test(html), '降级链要按序号排出顺序');
});

await t('探活：真失败与"不配向量"分别渲染成 fail / skipped（两层结论不合并）', async () => {
  const ids = globalThis.__modelIds;
  const { dom, sandbox, calls } = await openGovPage('#/models');

  // 向量条目：真实失败（录制时指向必拒端口）
  await sandbox.window.App.probeModel(ids.embed);
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/model/providers/' + ids.embed + '/probe'), '探活应真的 POST');
  let html = dom.state.html;
  assert.ok(/最近一次探活/.test(html), '应显示探活结果面板');
  assert.ok(/unreachable/.test(html), '真实失败原因要传到界面（不能只显示"失败"）：'
    + html.replace(/\s+/g, ' ').slice(0, 300));

  // "不配向量"：预期跳过 —— 必须显示成与失败不同的级别
  await sandbox.window.App.probeModel(ids.none);
  await settle(calls);
  html = dom.state.html;
  assert.ok(/skipped/.test(html), '跳过应显示 skipped，而不是 fail');
  assert.ok(/预期状态/.test(html), '跳过要说明"这是预期状态，不是故障"');
});

await t('模型页动作：登记 / 设为默认 / 启停 / 删除都真的打到了接口', async () => {
  const ids = globalThis.__modelIds;
  const { dom, sandbox, calls } = await openGovPage('#/models');

  // 登记：读表单 → POST
  dom.byId('md-name').value = '动作探针模型';
  dom.byId('md-protocol').value = 'anthropic-messages';
  dom.byId('md-base').value = 'http://127.0.0.1:1';
  dom.byId('md-model').value = 'probe';
  await sandbox.window.App.createModel();
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/model/providers'), '登记应真的 POST');
  assert.ok(/已登记模型条目/.test(dom.state.html), '登记后要有可见反馈');

  // 设为默认
  await sandbox.window.App.setModelDefault(ids.embed);
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/model/providers/' + ids.embed + '/default'), '设为默认应真的 POST');
  assert.ok(/已设为/.test(dom.state.html), '设默认后要有可见反馈');

  // 启停
  await sandbox.window.App.toggleModel(ids.none, false);
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/model/providers/' + ids.none + '/enabled'), '启停应真的 POST');

  // 删除：要过确认弹层
  const pd = sandbox.window.App.deleteModel(globalThis.__modelDeleteId, '录制待删条目');
  await answer(sandbox, dom);
  await pd;
  await settle(calls);
  assert.ok(calls.some((c) => c === 'DELETE /api/model/providers/' + globalThis.__modelDeleteId), '删除应真的 DELETE');
  assert.ok(/已删除/.test(dom.state.html), '删除后要有可见反馈');
});

await t('模型页 · 单价列：配了价的显示币种与四类价，没配的如实显示「未定价」（不是 ¥0.00）', async () => {
  const ids = globalThis.__modelIds;
  const { dom, sandbox, calls } = await openGovPage('#/models');
  let html = dom.state.html;
  assert.ok(/单价/.test(html), '表头要有单价列 —— 否则"成本金额从哪来"在页面上无从查证');
  assert.ok(/每 100 万 token/.test(html), '单位必须写在界面上（填成"元"会差 100 倍，而且算出来看着完全正常）');
  assert.ok(/CNY/.test(html), '配了价的条目要显示币种');
  assert.ok(/未定价/.test(html), '没配单价的条目要显示「未定价」');
  // 最要紧的一条：**不能**把"未定价"渲染成金额 0。
  assert.ok(!/¥\s?0\.00|CNY 0\.00/.test(html), '未定价绝不能显示成 0.00');
  assert.ok(/<details/.test(html), '配了写权限时应能就地改单价');

  // 就地改单价：真的发 PUT，反馈里要带上"改价不追溯"的提醒
  dom.byId('mp-' + ids.chat + '-currency').value = 'CNY';
  dom.byId('mp-' + ids.chat + '-priceInMinor').value = '2000000';
  dom.byId('mp-' + ids.chat + '-priceOutMinor').value = '2000000';
  await sandbox.window.App.setModelPrice(ids.chat);
  await settle(calls);
  assert.ok(calls.includes('PUT /api/model/providers/' + ids.chat),
    '改单价必须真的 PUT（服务端那道校验是唯一能拦住负数/小数单价的闸）');
  html = dom.state.html;
  assert.ok(/已更新/.test(html), '改完要有可见反馈');
  assert.ok(/不追溯/.test(html), '要提醒"改价不会改写历史金额" —— 否则没人想得到口径会变');
  // 改完单价必须顺带刷新成本面板，否则会出现"金额没变、价已经变了"的自相矛盾页面
  assert.ok(calls.includes('GET /api/governance/cost'), '改价后应重新拉成本（金额依赖单价）');
});

await t('切换用途会换掉协议可选值（不让人白填一遍再被服务端拒）', async () => {
  const { dom, sandbox } = await openGovPage('#/models');
  // 断言范围收窄到**登记表单**的协议下拉（0.16.0 起页面还有行内编辑器，
  // 向量条目的编辑器合法地含 Ollama 选项 —— 整页断言会把合法内容也算进来）
  const formProtos = (h) => { const m = h.match(/<select id="md-protocol">[\s\S]*?<\/select>/); return m ? m[0] : ''; };
  // 默认 chat：协议里只应有 anthropic-messages / openai-compat
  assert.ok(/Anthropic Messages/.test(formProtos(dom.state.html)), '对话用途应有 Anthropic Messages');
  assert.ok(!/Ollama/.test(formProtos(dom.state.html)), '对话用途不应出现 Ollama（那是向量接口）');

  sandbox.window.App.switchModelKind('embedding');
  const html = dom.state.html;
  assert.ok(/Ollama/.test(formProtos(html)), '切到向量用途后应出现 Ollama');
  assert.ok(/不配向量/.test(formProtos(html)), '向量用途应允许"不配向量"');
});

await t('模型页权限收敛：无 model:read 时侧栏无入口，也不请求模型接口', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  assert.ok(perms.model, '前置：owner 的权限矩阵应显式含 model 资源（否则本用例测不到东西）');
  perms.model.read = false;
  const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: perms });
  await sandbox.window.App.login();
  await settle(calls);
  assert.ok(!/#\/models/.test(dom.state.html), '无 model:read 不应出现模型入口');
  assert.ok(!calls.some((c) => c.includes('/api/model/')), '不应请求模型接口');
});

/* ── 对话工作台（P0-B）────────────────────────────────────────── */

section('对话工作台：落地页、流式渲染、权限收敛');

/**
 * 工作台要用的接口桩。
 *
 * 为什么用 overrides 而不是"录真实响应"：工作台的输入是**一串 NDJSON 帧**，
 * 真实服务端会逐帧到达；录制只能录到"最后一帧的拼接结果"，测不出"帧被逐条解析"。
 * 这里直接给出一段帧文本，正好把"帧 → 消息"的解析路径钉住。
 */
const WB_SID = 'ks_workbench_demo';
const WB_NDJSON = [
  JSON.stringify({ kind: 'meta', sessionId: WB_SID }),
  JSON.stringify({ kind: 'turn', turnId: 'kt-1', accepted: true }),
  JSON.stringify({ kind: 'event', event: { seq: 1, type: 'turn-start', role: 'user', text: '工作台你好', known: true } }),
  JSON.stringify({ kind: 'event', event: { seq: 2, type: 'reasoning', role: 'assistant', delta: '（测试替身）先理解问题。', known: true } }),
  JSON.stringify({ kind: 'event', event: { seq: 3, type: 'message', role: 'assistant', delta: '收到：工作台你好', known: true } }),
  // ⚠️ 0.21.10：这里的 tool-result 此前**带了 name**（`tool: { name: 'stub.echo', … }`），
  //    而真上游**不带**（只有 `message.toolCallId`）。夹具比真实世界"更友好"，
  //    于是"按名字配对"在夹具里永远成功 —— 空名孤儿卡这个真 bug 就藏在这道缝隙里。
  //    现在按真形状造：结果侧 name 为空、两侧都带 callId。
  JSON.stringify({ kind: 'event', event: { seq: 4, type: 'tool-call', role: 'assistant', tool: { name: 'stub.echo', args: { text: '工作台你好' }, status: 'running', callId: 'cid-1' }, known: true } }),
  JSON.stringify({ kind: 'event', event: { seq: 5, type: 'tool-result', role: 'tool', tool: { name: '', result: '工作台你好', status: 'ok', callId: 'cid-1' }, known: true } }),
  JSON.stringify({ kind: 'event', event: { seq: 6, type: 'usage', role: 'assistant', usage: { input: 128, cacheRead: 0, cacheWrite: 0, output: 64, reasoning: 16 }, known: true } }),
  JSON.stringify({ kind: 'event', event: { seq: 7, type: 'turn-end', role: 'assistant', text: 'done', known: true } }),
  JSON.stringify({ kind: 'ping', ts: 1 }),
  // ⚠️ done 帧必须带 `attachments` —— **形状取自真实服务端**（kernel.mjs 的回合回执是
  // 恒定构造的：不管本轮有没有附件，四个数组都在）。这里曾漏掉整个字段，导致"done 帧
  // 缺 attachments"的假形状掩盖了一个真 bug：前端 done 处理漏读 `sent` → wbMsgHtml
  // 读 `at.sent.length` 崩 → **整页 render 冻结**（真机上表现为"流式接收中…"永不消失）。
  // 教训记在 71-app-workbench.js 的 done 分支：**桩与真实形状漂移，测出的通过不值钱**。
  JSON.stringify({ kind: 'done', eventsWritten: 7, lastSeq: 7, truncated: false, usageCollected: { written: 1, skipped: 0, totals: { input: 128, cacheRead: 0, cacheWrite: 0, output: 64, reasoning: 16 } }, artifactsRecorded: { written: 0, error: null }, attachments: { requested: 0, sent: [], injected: [], skipped: [], missing: [] } }),
].join('\n') + '\n';

const WB_HISTORY = [
  { seq: 1, type: 'turn-start', role: 'user', text: '历史上的一个问题', known: true },
  { seq: 2, type: 'message', role: 'assistant', delta: '（测试替身）收到：历史上的一个问题', known: true },
  { seq: 3, type: 'turn-end', role: 'assistant', text: 'done', known: true },
  // 带附件的一轮：turn-start 文本 = 用户输入 + 平台注入的两段（**真实形态**，标记一字不差）。
  // 前端必须把注入段剥掉再当气泡显示，否则用户气泡里会糊进整份附件正文。
  // 反过来，"装作用户只打了那几个字"也是错的 —— 所以剥掉之后要标注带了什么。
  //
  // 这里刻意同时放**两段**（附件正文 + 图片清单），因为它们的结局根本不同：
  //   附件正文 = 平台把字读出来拼进去（模型"读到"）；
  //   图片清单 = 平台告知"另有 N 张图作为内容块提交"（模型"看见"）。
  // 气泡上的回执必须把两件事分开说，混成一句"＋N 个附件"会掩盖这个差别。
  {
    seq: 4, type: 'turn-start', role: 'user',
    text: '请阅读附件 REC-36\n\n<<<STI-ATTACHMENTS>>>\n'
      + '【附件正文】以下几段是平台读到的附件全文，供你参考：\n\n'
      + '<attachment name="规格.txt" id="att_rec_text" bytes="42">\n回归录制：关键常量是 REC-36。\n</attachment>\n\n'
      + '【随附图片】本轮随附 1 张图片，已作为图片内容块提交给模型：\n  · 真图.png（png，68B）',
    known: true,
  },
  { seq: 5, type: 'message', role: 'assistant', delta: '（测试替身）收到：请阅读附件 REC-36', known: true },
  { seq: 6, type: 'turn-end', role: 'assistant', text: 'done', known: true },
];

/** 成员档权限：有 session:execute，但没有 artifact（工作台应据此少取数） */
function wbMemberPerms() {
  const p = JSON.parse(JSON.stringify(meBody.permissions));
  delete p.artifact;
  return p;
}

function wbOverrides(extra) {
  const ov = Object.create(null);
  ov['GET /api/kernel/sessions'] = {
    status: 200,
    body: {
      // canManage / isMine（0.21.1）：与真实路由同形状 —— 服务端用与动作守卫**同一个**
      // 判据算出"这条会话我能不能改名/删除/移动"，前端只负责照它亮菜单项。
      // 0.21.9：加了 `workspaceId`（会话一定有归属了）；`manageNeed` 从 null 改成 'write' ——
      // 那是 `sessionManageRight` 对"自己的会话"给出的**真实**答案（null 是已删除的
      // `ungrouped` 档留下的旧值，现在服务端不会再给 null）。
      items: [{ id: WB_SID, title: '工作台演示会话', cwd: '', kernelSessionId: 'up-1', eventCount: 3,
        ownerUserId: 'u-demo', isMine: true, canManage: true, manageNeed: 'write',
        workspaceId: 'wsp_demo_full',
        // 0.21.9：列表**也要带 presetId**（服务端确实回显它）—— 会话行现在**恒**显示模式段
        // （没记模式时说「未指定」），夹具漏掉这个字段就等于让所有用例只走"未指定"那一条分支。
        presetId: 'standard',
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:10:00Z' }],
      total: 1,
    },
  };
  ov['GET /api/kernel/models'] = {
    status: 200,
    body: {
      catalog: {
        groups: [{ provider: 'stub', models: [{
          id: 'stub-deterministic', label: '测试替身模型',
          // 推理等级（0.21.0）：与真实目录同形状（reasoning.efforts + defaultEffort），
          // 工作台的等级下拉与"换模型回落默认档"的逻辑都靠它。
          reasoning: {
            efforts: [
              { id: 'off', name: 'Off', description: '简单任务，不需要推理。' },
              { id: 'high', name: 'High', description: '多数任务的默认档。' },
            ],
            defaultEffort: 'high',
          },
        }] }],
        default: { provider: 'stub', model: 'stub-deterministic' },
        routableProviders: ['stub'], failures: [], source: 'kernel-stub',
      },
    },
  };
  ov['GET /api/kernel/sessions/' + WB_SID] = {
    status: 200,
    body: {
      session: {
        id: WB_SID, title: '工作台演示会话', modelProvider: 'stub', modelId: 'stub-deterministic',
        // 0.21.0：会话详情要能回答"在哪个工作区 / 什么模式 / 什么推理等级"。
        // 0.21.9：演示会话**不再挂在"未分组"上**（那个桶随 ④ 一起删了）—— 它挂在
        // 兜底工作区里，与"每个会话都属于某个工作区"这条不变量一致。
        workspaceId: 'wsp_demo_full', presetId: 'standard', reasoningEffort: 'high',
      },
      usage: { input: 128, output: 64, cacheRead: 0, reasoning: 16, usageEvents: 1 },
      eventCount: 6,
    },
  };
  // ── 0.21.6 工作区树 / 模式清单桩 ─────────────────────────────
  // 形状照抄真实路由（app/http/routes/workspace.mjs、kernel.mjs 的 presets）：
  // 两个工作区 —— 树要能同时渲染多行、行与行之间不互相串。
  // ⚠️ 桩里**刻意不再有** myLevel / myReason / visibility / grantRoles / levelLabels：
  //    那是已删除的工作区权限模块的形状，留在桩里会测出一个真实服务端给不出的界面。
  ov['GET /api/workspaces'] = {
    status: 200,
    body: {
      // 0.21.9：`ungroupedCount` 换成 `isDefault` + `defaultWorkspaceId`（「未分组」那个桶
      // 整个删掉了，改成"每个组织一个兜底工作区"）。演示工作区**就是**那个兜底的 ——
      // 夹具里让它当默认，是因为它现在也是"新会话默认落进去"的那一个（`wsActiveId`），
      // 与 0.21.2 起的行为一致，不必连带改一堆断言。
      items: [
        { id: 'wsp_demo_full', name: '演示工作区', cwd: 'C:/demo', description: '回归用',
          ownerUserId: 'u-demo', sessionCount: 0, isDefault: true,
          createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
        { id: 'wsp_demo_view', name: '另一个演示区', cwd: '', description: '',
          ownerUserId: 'u-other', sessionCount: 0, isDefault: false,
          createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
      ],
      defaultWorkspaceId: 'wsp_demo_full',
    },
  };
  ov['GET /api/kernel/presets'] = {
    status: 200,
    body: {
      // 与 测试替身 provider 同构的四档（实测上游 agentPresets/list 形状：只有 id/order/isDefault）
      presets: [
        { id: 'standard', order: 1, isDefault: true },
        { id: 'ptc', order: 2, isDefault: false },
        { id: 'minimal', order: 3, isDefault: false },
        { id: 'cordis', order: 4, isDefault: false },
      ],
      source: 'kernel-stub',
    },
  };
  ov['GET /api/kernel/sessions/' + WB_SID + '/events'] = { status: 200, body: { items: WB_HISTORY, count: WB_HISTORY.length } };
  ov['POST /api/kernel/sessions/' + WB_SID + '/turns/stream'] = { status: 200, text: WB_NDJSON };

  // ── 3.6 工作台最后一公里 ──────────────────────────────────────────
  // 附件的 id 取自**录制段真实上传**的那两个（不是编的）：否则"点下载打到哪个附件"
  // 这条路径在回放里根本测不到。形状（kind/injectable/bytes/limits）与真实响应一致。
  const w36 = globalThis.__wb36 || {};
  // delivery 是服务端给的**结论**（图片按魔数认出来的），前端只转述不重算 ——
  // 三个附件刻意覆盖三种结局，回放页才有得可渲染。
  const att = (id, name, kind, bytes, delivery, mime) => ({
    id, sessionId: WB_SID, name, mime: mime || '', bytes, kind, delivery,
    sha256: 'rec', createdAt: '2026-10-01T00:00:00Z',
  });
  ov['GET /api/kernel/sessions/' + WB_SID + '/attachments'] = {
    status: 200,
    body: {
      items: [
        att(w36.textId || 'att_rec_text', '规格.txt', 'text', 42, 'text', 'application/octet-stream'),
        att(w36.binId || 'att_rec_bin', '图.png', 'binary', 8, 'none', 'application/octet-stream'),
        att(w36.imgId || 'att_rec_img', '真图.png', 'binary', 68, 'image', 'image/png'),
      ],
      count: 3,
      limits: {
        maxBytes: 8 * 1024 * 1024, injectMaxBytes: 96 * 1024, injectPerFileMax: 64 * 1024,
        imagePerFileMax: 8 * 1024 * 1024, imageTotalMax: 10 * 1024 * 1024,
        imageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      semantics: {
        image: '图片（按内容识别为 image/png / image/jpeg / image/webp / image/gif）发送时作为**图片内容块**提交给模型。',
        text: '文本附件（≤ 64KB）的正文会在发送时被拼进本轮上下文。',
        other: '其余通用文件仅登记、展示与下载，不会送给模型。',
      },
    },
  };
  // 0.21.7：这里原来还有一个 `GET …/search` 桩（会话内检索的命中列表）。检索整块删除，
  // 桩也一起去掉 —— 留着它会让回放页挂着一个界面永远打不到的路由。
  // ── 能力清单桩：只喂**还存在**的能力（Skill / MCP / 插件）──
  // ⚠️ 0.21.10：这里原来还有 `kernel.tools` / `kernel.blocked` / `kernel.toolsNote`
  //    / `kernel.toolsError` / `registryTools` / 以及一句"registryTools 只回答…"的 note。
  //    工具不再是可登记的能力，这些字段在真实响应里**已经不存在**，桩也必须一起删 ——
  //    留一个比真实路由"更宽"的桩，回放页就会替平台把已经删掉的东西继续渲染出来，
  //    于是"删干净了没有"这个问题**永远测不出来**（桩会把缺口补上）。
  // 形状照抄真实路由（app/http/routes/capability.mjs）：
  //   登记表一条、内核探测两条（其中一条与登记表重叠 → 对账要如实列出差距）、插件一条。
  //   （Skill 的"已登记未探测到"差距**仍然存在**，因为 Skill 仍然是一等能力。）
  ov['GET /api/capability/skills'] = {
    status: 200,
    body: {
      registry: [
        { name: 'rec-record', source: 'bundled', version: '1.0.0', path: 'skills/rec-record', enabled: true, modelInvocable: true, installedAt: '2026-10-01T00:00:00Z', meta: {} },
        // 刻意再放一条内核没探测到的：面板要把「已登记未探测到」的差距如实列出来
        { name: 'legacy-skill', source: 'bundled', version: '0.9.0', path: 'skills/legacy-skill', enabled: false, modelInvocable: false, installedAt: '2026-09-01T00:00:00Z', meta: {} },
      ],
      kernel: {
        skills: [
          { name: 'rec-record', description: '录制回归用例', modelInvocable: true },
          { name: 'weather-query', description: '查天气（测试替身）', modelInvocable: false },
        ],
        blocked: [],
        pluginCount: 1,
        plugins: [{ entryId: 'ep-1', moduleName: 'weather', title: '天气插件', description: '示例插件' }],
        error: null, source: 'external-kernel',
      },
      note: 'registry = 平台登记（治理真相源）；kernel = 内核本机探测。',
    },
  };
  // registry 两条覆盖 enabled×health 两态；kernel.servers 为空（上游未配置 MCP 是合法实况）。
  ov['GET /api/capability/mcp'] = {
    status: 200,
    body: {
      registry: [
        { name: 'fs', transport: 'stdio', enabled: true, health: 'ok', healthDetail: '', healthAt: '2026-10-01T00:00:00Z', hasConfig: true },
        { name: 'web', transport: 'http', enabled: false, health: 'unknown', healthDetail: '', healthAt: '', hasConfig: false },
      ],
      kernel: { servers: [], blocked: [], source: 'external-kernel', error: null },
      note: 'health = unknown（还没探过）/ ok / error（详情见 healthDetail）。',
    },
  };
  ov['POST /api/kernel/sessions/' + WB_SID + '/cancel'] = {
    status: 200,
    body: {
      ok: true, cancelled: true, turnId: 'kt-1', upstream: { attempted: true, ok: true },
      eventsAlreadyPersisted: 7,
      note: '已向上游发出取消；此前收到的事件已落库，不会因取消而丢弃某一轮的全部轨迹。',
    },
  };
  return Object.assign(ov, extra || {});
}

/** 打开工作台：登录 → 清空 hash（模拟真实浏览器首次打开）→ 等异步收敛 */
async function openWorkbench(opts = {}) {
  const ctx = await runApp({
    needsSetup: false,
    permissions: wbMemberPerms(),
    overrides: wbOverrides(),
    ...opts,
  });
  await ctx.sandbox.window.App.login();
  await settle(ctx.calls);
  // ⚠️ 沙箱的 location.hash 初值是 '#/overview'（多数老用例依赖这一点）；
  // 而真实浏览器首次打开时 hash 是**空的**。"落地页"这条语义只有在空 hash 下才成立，
  // 所以这里显式清空并触发 hashchange —— 否则测的就不是默认落地页，而是显式跳转。
  ctx.dom.window.location.hash = '';
  const onChange = ctx.dom.state.listeners['window:hashchange'];
  if (onChange) onChange();
  await settle(ctx.calls);
  return ctx;
}

/**
 * 切到会话框里的「轨迹」选项卡，并把**整页重新渲染**后的 HTML 交回来（0.21.9 定版）。
 *
 * 为什么需要它：0.21.9 起消息流里**只留正文**，工具卡 / 推理过程 / 知识库回执 /
 * 附件回执 / 用量徽标 / 原始事件折叠整体搬去了「轨迹」选项卡（用户裁定，理由见
 * 84-workbench.js 的 wbMsgHtml / wbViewTabsHtml 注释）。
 * 于是那些断言不能再对着"消息流所在的那份 html"写 —— 它们要先切到那个选项卡。
 *
 * ⚠️ 它**不再需要打开右栏**：0.21.9 定版把轨迹从右栏搬回了会话框
 *    （用户：「轨迹不要放到右侧栏，放到会话框中（会话框中选项卡对话、轨迹）」），
 *    所以这里只动一个 `viewTab`。第一版是 `railOpen = true` + `railTab = 'trace'`，
 *    那两行现在会切到一个**不存在的东西**上（右栏没有 tab 了）。
 */
function openTrace(dom, sandbox) {
  // ⚠️ 0.21.9 修正：`State` 与 `render` **拿不到**，别再从 `dom` 里掏。
  //
  // 前端分片是**经典脚本**，而 `const State = {...}` 这种顶层 `const` 在 vm 里是
  // **词法声明**（落进 context 的 global lexical environment），**不会**变成
  // sandbox 对象的属性。实测：
  //     vm.runInContext('const State={};', ctx)  →  sandbox.State === undefined
  //     vm.runInContext('window.App={};', ctx)   →  sandbox.window.App === {...}   ← 有
  // 所以只有**显式赋值到 window 的**（`window.App = App`）才够得着。
  //
  // 唯一可靠的口子：把代码**送回 context 里执行**（那里能看见词法绑定）。
  // 用 `sandbox.window.App` 上现成的动作也行，但切选项卡要的就是 render ——
  // 没有对应的 App 方法，所以走这里。
  runInApp(sandbox, "State.wb.viewTab = 'trace'; render();");
  return dom.state.html;
}

/**
 * 在**前端自己的执行环境里**跑一小段代码（0.21.9）。
 *
 * 为什么需要它：`State` / `render` / 各渲染函数都是前端分片里的**顶层词法声明**
 * （`const` / `function`），在 Node 侧既不在 `sandbox` 上、也不在 `sandbox.window` 上
 * （见 `openTrace` 的说明）。想把状态拨到某个分支上，就只能把代码送进 context 跑。
 *
 * ⚠️ 它的用途是**准入陷阱**：只应该有"拨状态 + 重新渲染"这一种用法。
 *    能跑任意代码意味着测试可以绕过 App 直接改内部状态 —— 那样测出来的东西
 *    与真实用户路径无关。要模拟一次用户操作，优先用 `sandbox.window.App.xxx()`。
 */
function runInApp(sandbox, code) {
  const ctx = sandbox.__ctx;
  assert.ok(ctx, 'runInApp: 取不到 vm context —— sandbox 上要挂 __ctx（见 runApp）');
  vm.runInContext(code, ctx, { filename: 'test-inline.js', timeout: 5000 });
}

/**
 * 取 `#app` 当前的 HTML（0.21.9 补）。
 *
 * ⚠️ 为什么需要它：`sandbox.dom.state.html` 是**每次写 `#app` 的 innerHTML 时
 * 同步快照**下来的（见 createDom 里 `if (id === 'app') state.html = …`），
 * 即使那次写入发生在 vm 内部（`runInApp` 里调 `render()`）也会被记下 ——
 * 所以从**真实 DOM 节点**上读，比拿一个可能在别处缓存的字符串可靠。
 * 凡"先 runInApp 造状态、再断言渲染结果"的用例都该用它。
 */
function dom2html(sandbox) {
  const doc = sandbox.document;
  const el = doc && doc.querySelector ? doc.querySelector('#app') : null;
  if (el && el.innerHTML) return el.innerHTML;
  return (sandbox.__dom && sandbox.__dom.state && sandbox.__dom.state.html) || '';
}

/** 取 vm 内一个表达式的 typeof（探"垫片到底装没装上"用） */
function runInAppType(sandbox, expr = 'requestAnimationFrame') {
  const ctx = sandbox.__ctx;
  assert.ok(ctx, 'runInAppType: 取不到 vm context');
  return vm.runInContext('typeof (' + expr + ')', ctx, { filename: 'test-typeof.js', timeout: 5000 });
}

await t('登录后落地页就是对话工作台（不是概览页）', async () => {
  const { dom, calls, rejections } = await openWorkbench();
  assert.deepEqual(rejections.map((e) => String((e && e.message) || e)), [], '工作台渲染抛了未捕获异常');
  const html = dom.state.html;
  // 0.21.2 起工作台是**全屏视图**：左栏就是工作区树，不套管理外壳（顶栏 / 侧栏 / 页标题）。
  assert.ok(/wb-brand/.test(html), '落地页应是全屏工作台（有品牌头）');
  assert.ok(!/class="topbar"/.test(html), '工作台不该再套管理顶栏');
  assert.ok(!/class="page-title"/.test(html), '工作台不该再有页标题');
  // 0.21.6：左栏顶部那两个入口（「✦ 新会话」胶囊 / 「🧩 插件」）已按用户要求删除 ——
  // 建会话只有一个入口（工作区行右侧的「＋」），插件不在对话工作台上管。
  // 反向断言，防"删了入口但样式类还留着"这种半截状态。
  assert.ok(!/wb-new-chat/.test(html), '左栏顶部的「新会话」胶囊已删（建会话走工作区行的「＋」）');
  assert.ok(!/🧩/.test(html), '左栏顶部的「插件」入口已删');
  // ⚠️ 0.21.11：工作台左栏底部的账号条**回退成"一个链接"**（用户裁定：
  //    「对话工作台的那个账号下拉框我的账号 登出不行就去掉，还是保留原来只显示用户名，
  //      点击用户名称跳转到我的账号」）。于是这里那条"必须自带登出入口"的断言**反转**：
  //    工作台里**不再有** `data-act="logout"`。
  //
  //    为什么改成反向断言而不是直接删掉这条：删掉等于丢失"登出可达性"这个曾经被抓到的
  //    真缺陷的记录。反过来钉住它，等于把这个**已知后果**写在回归里 ——
  //    「工作台登不出去，要登出去管理后台」，谁将来把登出加回来（正确做法是一颗**独立的
  //    小按钮**，而不是再引一次下拉），这条会立刻红、逼他回来读这段。
  assert.ok(!/data-act="logout"/.test(html),
    '0.21.11 起工作台不再自带登出入口（账号条已回退成一个链接）——'
    + '要改这条，先读 84-workbench.js 的 wbAccountHtml 注释与 architecture.md §7.12.7');
  // 账号条本身仍在，且是**链接**（点名字跳我的账号），不是按钮 / 不是下拉。
  assert.ok(/wb-account/.test(html), '左栏底部仍要有账号条（只显示用户名）');
  assert.ok(!/wb-account-menu/.test(html), '账号下拉已删 —— 不许再出现下拉面板');
  assert.ok(/wb-account/.test(html), '应有账号条（名字 + 登出）');
  assert.ok(dom.byId('wb-stream'), '应有消息流容器 #wb-stream');
  assert.ok(dom.byId('wb-input'), '应有输入框 #wb-input');
  assert.ok(dom.byId('wb-model'), '应有模型选择器 #wb-model');
  assert.ok(calls.includes('GET /api/kernel/sessions'), '应拉会话列表');
  assert.ok(calls.includes('GET /api/kernel/models'), '应拉模型目录');
});

/* ── 左栏可读性两处（0.21.9，用户 2026-10-08）─────────────────────────────
 *
 * 用户原话两句，两句都是"看不清"，但**根因不同**，别当成一回事改：
 *   A「左侧栏顶部 STI HARNESS 样式再醒目一点，字体看是否再大点」
 *   B「鼠标划过工作区名称 三个点和加号（新建会话）样式再突出一点，看不清」
 *
 * A 是**字号 + 配色**：主体 14.5px → 17px，后半截从最淡灰改成品牌色。
 * B 是**图标盒 + 静息对比度**：那两颗钮里装的是内联 SVG，尺寸由 `.wb-ico` 定、
 *   **不由 font-size 定** —— 所以"把 font-size 调大"对它一点用都没有
 *   （我第一版就犯了这个错：只调 font-size，图标还是 14px）。
 *
 * ⚠️ 两条都用**样式断言**而不是行为断言：这是纯视觉改动，没有可观测的行为差异。
 *    视觉断言的通用风险是"钉得太死，动一下就红"，所以这里只钉**用户能看见的那几个
 *    数字**（字号 / 颜色 / 图标盒），不钉 padding、gap 这类布局细节。
 */
await t('左栏品牌字标：字号加大且后半截改用品牌色（不再是那档最淡的灰）', async () => {
  const css = WB_CSS().replace(/\/\*[\s\S]*?\*\//g, '');
  const logo = (/\.wb-logo\s*\{([^}]*)\}/.exec(css) || [])[1] || '';
  const suffix = (/\.wb-logo b\s*\{([^}]*)\}/.exec(css) || [])[1] || '';
  assert.ok(logo, 'style.css 里要有 .wb-logo 规则');
  assert.ok(suffix, 'style.css 里要有 .wb-logo b 规则（后半截 HARNESS 单独控制）');

  // ① 字号：用户说"看是否再大点"。从前 14.5px，钉住"必须明显大于侧栏正文(13px)"。
  const size = Number((/font-size:\s*([\d.]+)px/.exec(logo) || [])[1]);
  assert.ok(size >= 16,
    '品牌主体字号要明显大于侧栏正文（13px）—— 它是标头，不是正文。'
    + ' 用户：「字体看是否再大点」。实际：' + size + 'px');
  // ② 字重：醒目不能只靠字号，钉住它是加粗的。
  const weight = Number((/font-weight:\s*(\d+)/.exec(logo) || [])[1]);
  assert.ok(weight >= 700, '品牌主体要加粗（"醒目"的一半在这）：' + weight);
  // ③ 后半截颜色：从前是 --text-faint（最淡那档 = 禁用/占位的色），
  //    拿它当字标就是主动降低存在感；现在改走品牌色。
  assert.ok(!/--text-faint/.test(suffix),
    '后半截不许再用 --text-faint —— 那一档是"禁用/占位"的色，用在字标上等于主动变淡：' + suffix);
  assert.ok(/color:\s*var\(--accent\)/.test(suffix),
    '后半截要用品牌色（--accent）：它是字标，不是被淡化的补充说明：' + suffix);
  // ④ 反向：语言模板里两个字都要在（别改样式时把字改了）。
  const { dom } = await openWorkbench();
  assert.ok(/<span class="wb-logo">STI <b>HARNESS<\/b><\/span>/.test(dom.state.html),
    '字标结构保持 `STI ` + `<b>HARNESS</b>`（后半截的样式挂在 b 上）');
});

await t('工作区行划过时的 ⋯ / ＋：图标提到 16px 且静息有可见的底与边', async () => {
  const css = WB_CSS().replace(/\/\*[\s\S]*?\*\//g, '');
  // ★ 这一条是本用例的**重点**，也是我第一次改错的地方：
  //   那两颗钮里是**内联 SVG**（`wbIcon('more','sm')` / `wbIcon('plus','sm')`），
  //   尺寸由 `.wb-ico` 的 width/height 定 —— `font-size` 只管按钮盒的行高，对图形无效。
  //   所以"放大图标"必须写一条**作用到图标本身**的规则。
  const icon = (/\.wb-row-add \.wb-ico,[^{]*\.wb-row-more \.wb-ico\s*\{([^}]*)\}/.exec(css) || [])[1] || '';
  assert.ok(icon, '要有一条把行尾两颗钮里的图标放大的规则（只调 font-size 对 SVG 无效）');
  const iw = Number((/width:\s*(\d+)px/.exec(icon) || [])[1]);
  assert.ok(iw >= 16,
    '行尾图标的图标盒要提到基准档 16px（小号是 14px）。用户：「看不清」。实际：' + iw + 'px');
  assert.ok(/height:\s*\d+px/.test(icon), '图标盒要同时给 width 与 height（只给一个会变形）：' + icon);
  // ⚠️ 必须**同时**作用到 `.wb-row-more`：那颗 ⋯ 在两种位置出现 ——
  //    工作区行里包在 `.wb-row-ops` 内，**会话行里直接挂在 .wb-session 上**。
  //    只写 `.wb-row-ops .wb-ico` 会漏掉会话行那一颗，用户会看到"一颗大一颗小"。
  assert.ok(/\.wb-row-more\s+\.wb-ico/.test(css),
    '放大规则要覆盖 `.wb-row-more`（会话行的 ⋯ 不在 .wb-row-ops 里，只写那一个会漏）');
  // 作用域**不许**落在 `.wb-ico.sm` 基类上：小号图标别处在用（卡内 ＋、产物行…），
  // 改基类会变成"全站小图标都变大"——那是把"调这一处"做成了"调全站"。
  const smRule = (/\.wb-ico\.sm\s*\{([^}]*)\}/.exec(css) || [])[1] || '';
  const smSize = Number((/width:\s*(\d+)px/.exec(smRule) || [])[1]);
  assert.equal(smSize, 14, '`.wb-ico.sm` 基类要保持 14px —— 放大只调行尾那两颗钮: ' + smRule);

  // 静息长相：从前是 `transparent 底 + transparent 边 + --text-faint 字`，
  // 在"划过才现身"的前提下，现身那一刻看到的仍是一枚淡灰细字形。
  for (const cls of ['wb-row-add', 'wb-row-more']) {
    const rule = new RegExp('\\.' + cls + '\\s*\\{([^}]*)\\}').exec(css);
    const body = rule ? rule[1] : '';
    assert.ok(body, '找不到 .' + cls + ' 的规则');
    assert.ok(!/color:\s*var\(--text-faint\)/.test(body),
      '.' + cls + ' 的静息色不许是最淡那档（--text-faint）—— 那正是"看不清"的来源：' + body);
    assert.ok(/color:\s*var\(--text-dim\)/.test(body),
      '.' + cls + ' 的静息色用 --text-dim（这一档两主题下都够读）：' + body);
    assert.ok(/border:\s*1px solid var\(--border\)/.test(body),
      '.' + cls + ' 要有可见的边框 —— 划过现身那一刻就要能看出"这是按钮"：' + body);
    assert.ok(!/border:\s*1px solid transparent/.test(body),
      '.' + cls + ' 不许再用透明边（那正是"糊在栏上一块"的成因）：' + body);
  }
  // 两颗钮必须**成对**改：它们同一行、同时现身，只调一颗会出现"一个清楚一个糊"，
  // 比两颗都糊更像坏了。
  // （上面那个循环已经把两颗都查了，这条是把它写成一句人能读懂的不变式。）
});

await t('默认打开最近会话：历史事件被回放成消息（不是空白页）', async () => {
  const { dom } = await openWorkbench();
  const html = dom.state.html;
  assert.ok(/历史上的一个问题/.test(html), '历史里的用户消息应被回放');
  assert.ok(/收到：历史上的一个问题/.test(html), '历史里的助手增量应被回放');
});

await t('模型选择器：用内核目录填充（不是硬编码）', async () => {
  const { dom } = await openWorkbench();
  assert.ok(/测试替身模型/.test(dom.state.html), '选项文案应来自模型目录');
});

await t('0.21.9 模型目录分组只给 id（上游真实形状）时也要拼出可用的 provider —— 否则新建会话必 500', async () => {
  // 上游 `session/modelCatalog` 的分组用的是 **`id`**，**没有 `provider` 键**（0.2.0-rc.2 实测）。
  // 0.21.9 之前这里只读 `g.provider`：value 拼成 `|deepseek-flash` → 提交时 provider 为 null
  // → 上游回 `wire field "request" failed boundary validation` → 建会话 500。
  // ⚠️ 这条夹具必须照真实形状写：默认夹具用的是 `{provider:'stub'}`，**盖不到**这个 bug。
  const { dom } = await openWorkbench({
    overrides: wbOverrides({
      ['GET /api/kernel/models']: {
        status: 200,
        body: {
          catalog: {
            groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash', label: 'Flash 模型' }] }],
            default: { provider: 'deepseek-official', model: 'deepseek-flash' },
            routableProviders: ['deepseek-official'], failures: [], source: 'kernel-stub',
          },
        },
      },
    }),
  });
  const html = dom.state.html;
  const opts = html.match(/<option value="[^"]*"/g) || [];
  assert.ok(/<option value="deepseek-official\|deepseek-flash"/.test(html),
    '选项值必须是 provider|model 且两端都非空，实际：' + JSON.stringify(opts));
  assert.ok(!/<option value="\|/.test(html),
    '选项值不许以 `|` 开头（provider 段为空 = 提交时 provider 为 null）：' + JSON.stringify(opts));
});

await t('模型选择器就是会话的绑定项：不再有「未归因 / 已归因」这第三个概念（0.21.7）', async () => {
  // 这条用例替代了原来的两条（「显示已归因模型」/「未绑定模型时如实标注」）。
  // 用户裁定："模型未归因又是个什么…右边不是有模型选择和推理等级吗（右侧选择哪个模型
  // 会话就绑定哪个模型不行吗）" —— 于是做法是**把两者变成一件事**，而不是再补一个状态徽标：
  //   ① 会话已登记模型 → 选择器就该选中它（回显）；
  //   ② 界面上不再出现任何"归因状态"的徽标（没有东西可解释）。
  const { dom } = await openWorkbench();
  const html = dom.state.html;
  const sel = dom.byId('wb-model');
  assert.ok(sel, '应有模型选择器');
  // ⚠️ 断言瞄准**标记里的 selected**，而不是 `sel.value`：vm 的 DOM 垫片不实现
  //    "从 options 的 selected 属性推导 select.value"（见 createDom 里 makeElement 的
  //    `value: ''`），所以读 `sel.value` 在这里恒为空 —— 那是垫片的性质，不是行为。
  //    真实浏览器里 `value="stub|stub-deterministic" selected` 就是选中它。
  assert.ok(/<option value="stub\|stub-deterministic" selected>/.test(html),
    '会话登记过模型时，选择器要**选中**它 —— 选择器即绑定项，回显必须与服务端记下的一致，实际：'
    + html.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(!/模型未归因|已归因模型/.test(html),
    '不再有「未归因 / 已归因」徽标（选择器与绑定项恒等之后，它无事可报），实际：'
    + html.replace(/\s+/g, ' ').slice(0, 400));
});

await t('0.21.7：会话没绑模型时把「选择器选的」补登到服务端（两者恒等的实现）', async () => {
  // 上面那条用例的前提（"选中的 == 绑定的"）不是自动成立的：服务端 `agent_sessions.model_id`
  // 才是用量归因的真源，而发回合的请求体**不带模型**（只有 content + attachmentIds）。
  // 所以打开会话时若发现"选择器有值、服务端没记"，就地补登一次 —— 否则用户看到的模型
  // 可能不是真正在用的那个，而那正是被删掉的「未归因」徽标想解释却解释不动的东西。
  const { dom, calls } = await openWorkbench({
    overrides: wbOverrides({
      // 会话**没有**登记模型：老会话、或建会话时没选，都是真实存在的情况
      ['GET /api/kernel/sessions/' + WB_SID]: {
        status: 200,
        body: {
          session: { id: WB_SID, title: '工作台演示会话', modelProvider: '', modelId: '',
            workspaceId: null, presetId: 'standard', reasoningEffort: 'high' },
          usage: null, eventCount: 0,
        },
      },
      ['POST /api/kernel/sessions/' + WB_SID + '/model']: {
        status: 200,
        body: { ok: true, sessionId: WB_SID, recorded: { modelProvider: 'stub', modelId: 'stub-deterministic' }, note: '' },
      },
    }),
  });
  await settle(calls);
  assert.ok(calls.includes('POST /api/kernel/sessions/' + WB_SID + '/model'),
    '会话没绑模型时应按选择器当前值补登一次，实际调用：'
    + JSON.stringify(calls.filter((c) => c.includes('/model'))));
  assert.ok(!/切换模型失败/.test(dom.state.html), '补登是后台动作，不该弹成用户的错误');
});

await t('补登失败静默：没有登记权限时工作台照常可用，不报一个用户处理不了的错', async () => {
  const noWrite = wbMemberPerms();
  noWrite.session.write = false;
  const { dom, calls } = await openWorkbench({
    permissions: noWrite,
    overrides: wbOverrides({
      ['GET /api/kernel/sessions/' + WB_SID]: {
        status: 200,
        body: {
          session: { id: WB_SID, title: '工作台演示会话', modelProvider: '', modelId: '',
            workspaceId: null, presetId: 'standard', reasoningEffort: 'high' },
          usage: null, eventCount: 0,
        },
      },
      ['POST /api/kernel/sessions/' + WB_SID + '/model']: {
        status: 403, body: { ok: false, error: { code: 'forbidden', message: '缺少 session:write' } },
      },
    }),
  });
  await settle(calls);
  const html = dom.state.html;
  assert.ok(/id="wb-input"/.test(html), '页面仍应正常渲染（补登失败不能把工作台带崩）');
  assert.ok(!/切换模型失败/.test(html), '补登是后台动作，失败不该报成用户的错误（用户无从处理它）');
  assert.ok(!/模型未归因|已归因模型/.test(html), '也不该退回那个已删除的徽标');
});

await t('流式提交：帧被逐条解析成消息（正文 + 工具卡 + 用量）', async () => {
  const { dom, sandbox, calls } = await openWorkbench();
  dom.byId('wb-input').value = '工作台你好';
  await sandbox.window.App.wbSend();
  await settle(calls);

  assert.ok(calls.includes('POST /api/kernel/sessions/' + WB_SID + '/turns/stream'), '应打到流式接口');
  // ⚠️ 0.21.12 修正：这条用例的判据要按 0.21.9 的**两个视图**分开写。
  //    0.21.9 起消息流只留正文，工具卡 / 推理 / 用量 / 原始事件整体搬去了「轨迹」页签
  //    （用户裁定，见 84-workbench.js 的 wbMsgHtml / wbViewTabsHtml 注释）。
  //    从前这里在**同一份 html**（对话页签）里同时断言正文、工具卡、用量、轨迹折叠 ——
  //    那是 0.21.9 之前的形态，今天只可能失败。分视图断言与"拆分"这件事**同源**：
  //    正文在对话里、过程材料在轨迹里，两边都不许越界。
  const chat = dom.state.html;
  assert.ok(/收到：工作台你好/.test(chat), '正文应来自 message 事件增量');
  assert.ok(!/wb-tool-name|class="wb-tools"/.test(chat),
    '「对话」页签里不该有工具卡（它已搬到「轨迹」页签）');

  // 过程材料在「轨迹」页签里找（openTrace 会切过去并把整页 HTML 交回来）
  const trace = openTrace(dom, sandbox);
  assert.ok(/stub\.echo/.test(trace), '工具卡应显示工具名（在「轨迹」页签里）');
  assert.ok(/完成/.test(trace), 'tool-result 应把工具卡标成完成');
  assert.ok(/输入 128/.test(trace) && /输出 64/.test(trace), '用量应来自 done 帧的 totals');
  assert.ok(!/未定义|is not defined/.test(trace), '不得出现未定义引用');

  // 回到「对话」页签，验"done 帧之后渲染必须**收敛**"（bug 回归钉子，2026-10-02 真机实测抓到）：
  // done 处理曾把缺 `sent` 字段的 attachments 存进 msg.attach，wbMsgHtml 读
  // `at.sent.length` 抛 TypeError → render 崩 → DOM 冻结 —— 界面上"流式接收中…"
  // 和"停止"按钮永不消失（State.wb.streaming 其实已是 false）。渲染成功的直接
  // 证据：头部回到非流式形态（无 spinner 文案、无停止按钮）。
  sandbox.window.App.wbViewTab('chat');
  const html = dom.state.html;
  assert.ok(!/流式接收中/.test(html), 'done 帧后不得残留"流式接收中…"（render 冻结的病征）');
  // 0.21.2 起停止是右上角图标钮；0.21.7 起清屏那颗钮**整块删除**（用户裁定），
  // 动作 `wbReset` 也一起删了 —— 所以这里断言的是"确实没有了"，
  // 而不是像原来那样断言"done 之后它回来"。反着钉，才能挡住"删了按钮忘了删动作"。
  assert.ok(!/data-act="wbStop"/.test(html), 'done 帧后不得残留「停止」按钮');
  assert.ok(!/data-act="wbReset"/.test(html), '「清屏」已整块删除 —— 按钮与动作都不该再出现');
  assert.ok(!/wbReset\b/.test(html), '清屏入口在 DOM 里一点痕迹都不该留');
});

await t('工具卡配对（0.21.10 真 bug）：tool/result 不带名字，只有 callId —— 不许再多出 (未命名工具)', async () => {
  // ⚠️ 这条钉的是用户报的真 bug：「轨迹里面显示完成(未命名工具)」。
  //
  // 为什么既有用例没抓到它：上面那份 WB_NDJSON 夹具里 tool-result **带了 name**
  // （`tool: { name: 'stub.echo', ... }`）—— 而**真上游不这样**。真事件是：
  //     tool/call   → { callId, name, arguments }
  //     tool/result → { message: { toolCallId, content, isError } }   ← 没有 name
  // 夹具比真实世界"更友好"，于是"按名字配对"在夹具里永远成功，空名孤儿卡永远测不出来。
  // **夹具必须按真实形状造** —— 这正是这条用例存在的意义，不是为了多测一遍配对。
  const nd = [
    JSON.stringify({ kind: 'meta', sessionId: WB_SID }),
    JSON.stringify({ kind: 'turn', turnId: 'kt-pair', accepted: true }),
    JSON.stringify({ kind: 'event', event: { seq: 1, type: 'turn-start', role: 'user', text: '调工具', known: true } }),
    // 两次调**同名**工具：旧逻辑（按名字找最近一张未完成的卡）会把第二个 result 并到第一张上
    JSON.stringify({ kind: 'event', event: { seq: 2, type: 'tool-call', role: 'assistant', tool: { name: 'fs.read', args: { p: 'a.txt' }, status: 'running', callId: 'cid-A' }, known: true } }),
    JSON.stringify({ kind: 'event', event: { seq: 3, type: 'tool-call', role: 'assistant', tool: { name: 'fs.read', args: { p: 'b.txt' }, status: 'running', callId: 'cid-B' }, known: true } }),
    // 真形状：无 name、带 toolCallId
    JSON.stringify({ kind: 'event', event: { seq: 4, type: 'tool-result', role: 'tool', tool: { name: '', result: 'A 的内容', status: 'ok', callId: 'cid-A' }, known: true } }),
    JSON.stringify({ kind: 'event', event: { seq: 5, type: 'tool-result', role: 'tool', tool: { name: '', result: 'B 的内容', status: 'ok', callId: 'cid-B' }, known: true } }),
    JSON.stringify({ kind: 'event', event: { seq: 6, type: 'turn-end', role: 'assistant', text: 'done', known: true } }),
    JSON.stringify({ kind: 'done', eventsWritten: 6, lastSeq: 6, truncated: false, usageCollected: { written: 0, skipped: 0, totals: null }, artifactsRecorded: { written: 0, error: null }, attachments: { requested: 0, sent: [], injected: [], skipped: [], missing: [] } }),
  ].join('\n') + '\n';
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['POST /api/kernel/sessions/' + WB_SID + '/turns/stream']: { status: 200, text: nd },
    }),
  });
  dom.byId('wb-input').value = '调工具';
  await sandbox.window.App.wbSend();
  await settle(calls);
  const html = openTrace(dom, sandbox);

  const heads = html.match(/<div class="wb-tool-head">[\s\S]*?<\/div>/g) || [];
  assert.equal(heads.length, 2, '两次调用应只出两张卡（旧逻辑会多出两张空名孤儿卡）：' + heads.length);
  assert.ok(!/未命名工具/.test(html), '不该再出现「(未命名工具)」：' + html.replace(/\s+/g, ' ').slice(0, 500));
  // 每张卡都要有名字、都要是"完成"，且带着自己的结果（张冠李戴会在这里露馅）
  const nameCount = (html.match(/wb-tool-name">fs\.read</g) || []).length;
  assert.equal(nameCount, 2, '两张卡都要显示 fs.read，实际 ' + nameCount);
  const doneCount = (html.match(/badge ok">完成</g) || []).length;
  assert.equal(doneCount, 2, '两张卡都该被标成"完成"（不许停在"执行中"）：' + doneCount);
  const blocks = html.match(/<div class="wb-tool">[\s\S]*?<\/div><\/div>/g) || [];
  const card = (s) => blocks.find((b) => b.includes(s));
  const ca = card('a.txt'), cb = card('b.txt');
  assert.ok(ca && cb, '两张卡要各带自己的入参（a.txt / b.txt）');
  assert.ok(/A 的内容/.test(ca), 'cid-A 的结果必须落在 a.txt 那张卡上：' + ca);
  assert.ok(/B 的内容/.test(cb), 'cid-B 的结果必须落在 b.txt 那张卡上（不许并到第一张）：' + cb);
  assert.ok(!/B 的内容/.test(ca) && !/A 的内容/.test(cb), '两张卡的结果绝不能张冠李戴');
});

/* ── 右栏「可用能力」/「实际调用」两个面板：整块删除（0.21.7）──────────────
 *
 * 这里曾有三条用例（以及上面那个 openWorkbenchRail 帮手）：
 *   ① 右栏「可用能力」面板（技能 / MCP / 工具 / 插件四段 + 顺序）
 *   ② 右栏「实际调用」（工具调用与清单精确同名对账，三态）
 *   ③ 无 skill:read / mcp:read 权限时两面板都不渲染
 *
 * 用户裁定「上下文面板内容（实际调用删除、可用能力删除）」，所以面板本身
 *（`wbCapsHtml` / `wbCollectCalls` / `wbCallsHtml`）已整块删除，这三条用例随之去掉。
 * 留着它们只会测一个界面上不存在的面板 —— 那种"看起来还在"的残留正是删除时要清干净的东西。
 *
 * ⚠️ 删的只是**右栏那两块展示**，事实本身一件没丢：
 *   · 工具调用仍然是**会话事实**，工具卡照旧在「轨迹」页签里逐条渲染 —— 那条用例在下面保留；
 *   · 但**来源徽标已删除**（0.21.10）：徽标要回答"这个工具从哪来"，而工具不是可登记的能力，
 *     没有清单可以对账，硬算出来的"来源"只能是猜的。所以 `wbAttributeTool` / `wbCatalog` /
 *     `wbAlsoIn` 连同一整条对账链（`w.caps` 的拉取、`originText` / `ORIGIN_LABEL`）一起删掉。
 *   · `w.capsMcp` 的拉取**没有删**（MCP 面板另有消费者），对应的桩与权限收敛断言照旧。
 */

await t('工具卡（0.21.10）：仍然逐条渲染、结构与富格式不变；来源徽标整块不再存在', async () => {
  // 这条的历史：0.21.7 从被删的「实际调用」用例里摘出来保留时，验的是**来源徽标**。
  // 0.21.10 用户裁定「工具卡留，只去掉来源徽标」—— 于是断言一分为二：
  //   留下的是"工具卡还在、还认得出来"（会话事实，与任何登记表无关）；
  //   删掉的是"徽标写什么"（它依赖一个已经不存在的对账数据源）。
  // ⚠️ `.wb-tool-head` 这个容器**必须保持不变** —— 它在 0.20 起的多条用例里被当作卡片锚点，
  //    改结构会让"工具卡还在不在"这个问题换一个地方测，等于偷偷降低了覆盖。
  const nd = [
    JSON.stringify({ kind: 'meta', sessionId: WB_SID }),
    JSON.stringify({ kind: 'turn', turnId: 'kt-calls', accepted: true }),
    JSON.stringify({ kind: 'event', event: { seq: 1, type: 'turn-start', role: 'user', text: '调一个工具', known: true } }),
    JSON.stringify({ kind: 'event', event: { seq: 2, type: 'tool-call', role: 'assistant', tool: { name: 'stub.echo', args: {}, status: 'running' }, known: true } }),
    JSON.stringify({ kind: 'event', event: { seq: 3, type: 'tool-result', role: 'tool', tool: { name: 'stub.echo', result: 'ok', status: 'ok' }, known: true } }),
    // 名字里带 MCP 服务名（登记的服务叫 fs）的工具卡也要正常渲染 —— 与来源无关，
    // 只是要确保卡片渲染不依赖任何"能不能查到出处"的判定（查不到就不渲染 = 丢事实）
    JSON.stringify({ kind: 'event', event: { seq: 4, type: 'tool-call', role: 'assistant', tool: { name: 'fs.read', args: {}, status: 'running' }, known: true } }),
    JSON.stringify({ kind: 'event', event: { seq: 5, type: 'tool-result', role: 'tool', tool: { name: 'fs.read', result: 'ok', status: 'ok' }, known: true } }),
    JSON.stringify({ kind: 'event', event: { seq: 6, type: 'turn-end', role: 'assistant', text: 'done', known: true } }),
    JSON.stringify({ kind: 'done', eventsWritten: 6, lastSeq: 6, truncated: false, usageCollected: { written: 0, skipped: 0, totals: null }, artifactsRecorded: { written: 0, error: null }, attachments: { requested: 0, sent: [], injected: [], skipped: [], missing: [] } }),
  ].join('\n') + '\n';
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['POST /api/kernel/sessions/' + WB_SID + '/turns/stream']: { status: 200, text: nd },
      // 桩也收窄成真实形状（没有 tools / registryTools / toolsNote）：
      // 留一个更宽的桩，就等于替平台把已经删掉的字段继续喂给前端，缺口永远测不出来
      ['GET /api/capability/skills']: {
        status: 200,
        body: {
          registry: [],
          kernel: {
            skills: [], blocked: [], pluginCount: null, plugins: [],
            error: null, source: 'external-kernel',
          },
          note: 'registry = 平台登记（治理真相源）；kernel = 内核本机探测。',
        },
      },
    }),
  });
  dom.byId('wb-input').value = '调一个工具';
  await sandbox.window.App.wbSend();
  await settle(calls);
  // 0.21.9：工具卡在会话框的「轨迹」页签里（消息流只留正文）—— 断言前先切过去
  const html = openTrace(dom, sandbox);

  // 每个工具卡各取一个 head 来验（此前只取第一个，工具一多就漏）
  const heads = html.match(/<div class="wb-tool-head">[\s\S]*?<\/div>/g) || [];
  const headOf = (name) => heads.find((h) => h.indexOf('>' + name + '<') !== -1);
  const echoHead = headOf('stub.echo'), fsHead = headOf('fs.read');
  assert.ok(echoHead, 'stub.echo 的工具卡要渲染，实际卡片数：' + heads.length);
  assert.ok(fsHead, 'fs.read 的工具卡要渲染 —— 渲染不依赖"能不能查到出处"');
  assert.equal(heads.length, 2, '两张卡各渲染一次，不应有额外卡片：' + heads.length);
  // 反向钉：徽标（以及它依赖的一切口径文字）必须**彻底不在**。
  // 用 wb-tool-head 的**内部**做判定，避免误伤别处的文字。
  for (const [label, h] of [['stub.echo', echoHead], ['fs.read', fsHead]]) {
    assert.ok(!/登记表：/.test(h), label + ' 卡上不该再有来源徽标：' + h);
    assert.ok(!/内核探测到/.test(h), label + ' 卡上不该再有内核探测徽标：' + h);
    assert.ok(!/未登记（上游未报告来源）/.test(h), label + ' 卡上不该再有"未登记"结论：' + h);
  }
  assert.ok(!/wb-tool-origin|wb-attribute/.test(html), '徽标用的样式类不该还留在 DOM 里');
  // 前端也不该再为徽标去拉能力清单 —— 那条请求在 0.21.10 已删除（它当时唯一的读者就是徽标）
  //
  // ⚠️ 0.21.12 修正：判据不能是"整份 calls 里没有 `GET /api/capability/skills`"。
  //    那条请求**今天仍然会发**，但发它的人不是工作台 —— 是登录后的**一次性预热**
  //    （`50-boot.js` 的 `loadAll()` 把每个管理页的数据都拉一遍，里面就有
  //    `App.loadCapability()`；见 70-app.js）。`openWorkbench()` 会先登录，
  //    所以这条请求必然在 calls 里。原判据等于要求"登录不许预热能力清单" ——
  //    那是另一个话题（要不要懒加载管理页），与本用例要钉的
  //    "**工作台自己的加载器**不再为来源徽标拉它"不是一回事。
  //    正确的判据：读**工作台那一段**源码（`71-app-workbench.js`），
  //    确认它的加载链里没有这条请求 —— 这才是 0.21.10 那次删除的落点。
  const wbSrc = fs.readFileSync(path.join(ROOT, 'public', 'app', '71-app-workbench.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/capability\/skills/.test(wbSrc),
    '工作台的加载器不该再拉能力清单（来源徽标已删，`w.caps` 一个读者都没有了）');
  // 而 MCP 那份**要保留**：右栏的 MCP 材料另有消费者（0.21.10 只删了 skills 那一次）。
  assert.ok(/capability\/mcp/.test(wbSrc),
    'MCP 清单的拉取必须保留 —— 删它会让右栏的 MCP 段落没有数据源');

  // 反向断言：右栏那两块展示**确实没了**（不是只把按钮藏起来）
  assert.ok(!/wb-caps-sec|<h2>可用能力<\/h2>/.test(html), '右栏「可用能力」面板应整块删除');
  assert.ok(!/<h2>实际调用（本会话）<\/h2>|<div class="wb-call">/.test(html), '右栏「实际调用」面板应整块删除');
});

/* ── 0.21.0 工作区树与选择器（0.21.6 收口：行尾「⋯ / ＋」、权限模块整块删除）───── */

await t('工作台 0.21.6：工作区树渲染（行尾「⋯」与「＋」/ 未分组桶 / 会话归组）', async () => {
  // 演示会话这次挂进工作区，归组渲染才有得验证
  const { dom, sandbox } = await openWorkbench({ overrides: wbOverrides({
    ['GET /api/kernel/sessions']: {
      status: 200,
      body: { items: [{ id: WB_SID, title: '工作台演示会话', cwd: '', kernelSessionId: 'up-1',
        ownerUserId: 'u-demo', isMine: true, canManage: true, manageNeed: 'write',
        workspaceId: 'wsp_demo_full', eventCount: 3, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:10:00Z' }], total: 1 },
    },
  }) });
  const html = dom.state.html;
  // 0.21.7：工作区名前那颗 📁 emoji 换成内联 SVG（emoji 是**彩色位图**：字号一变大小就跟着变、
  // 各平台画风也不同 —— 与用户说的"图标有大有小"是同一类病）。名字本身仍在 .wb-ws-label 里，
  // 省略号由它承担（图标固定 14px 不参与压缩）。
  assert.ok(/wb-ws-name[^>]*><svg class="wb-ico sm"/.test(html),
    '工作区名前的文件夹图标要渲染，且必须是统一尺寸的 .wb-ico.sm（不是 emoji）');
  assert.ok(/<span class="wb-ws-label">演示工作区<\/span>/.test(html), '工作区节点要渲染');
  assert.ok(!/📁/.test(html), '工作台里不许再出现 📁 —— 图标一律走一套内联 SVG');

  // 行尾两个动作**恒在 DOM 里**（显隐交给 CSS 的 hover，不是条件渲染）——
  // 这一点必须钉住：真机层只能靠 hover 让它们现身，DOM 里没有就等于功能没做。
  assert.ok(/data-act="wbToggleRowMenu" data-a1="ws" data-a2="wsp_demo_full"/.test(html), '工作区行要有「⋯」');
  assert.ok(/data-act="wbNewSessionIn" data-a1="wsp_demo_full"/.test(html),
    '工作区行要有「＋ 新会话」，且**不用**先点开 ⋯ —— 0.21.6 把它提到行上（建会话是这一行最高频的动作，'
    + '藏在二级菜单里等于"点开 ⋯ 才知道这里能建会话"）');
  const ops = html.match(/<span class="wb-row-ops">[\s\S]*?<\/span>/);
  assert.ok(ops, '两个动作要包在 .wb-row-ops 里（hover 显隐的容器）');
  assert.ok(ops[0].indexOf('wbToggleRowMenu') < ops[0].indexOf('wbNewSessionIn'),
    '顺序：⋯ 在左、＋ 在右（用户描述的就是这个顺序）：' + ops[0]);

  // 0.21.1：管理入口收进行内「⋯」菜单 —— 默认 html 里**不该**直接摊着这些按钮
  assert.ok(!/data-act="wbRenameWs"/.test(html), '未展开菜单时不该直接摊出管理入口（一行就是一行）');

  // 菜单分两种行来钉（0.21.9）：
  //   · **普通工作区**（另一个演示区）→ 改名 / 删除两个**可点**入口；
  //   · **兜底工作区**（演示工作区，夹具里 isDefault=true）→ 同样两项，但**都禁用**
  //     并写明"为什么不能动"。摆一个点了必然 403 的按钮读起来像产品坏了，
  //     把菜单项撤掉则让人以为"这一行没有这个功能" —— 禁用 + 一句理由才是对的那条路。
  await sandbox.window.App.wbToggleRowMenu('ws', 'wsp_demo_view');
  const opened = dom.state.html;
  assert.ok(/data-act="wbRenameWs"/.test(opened) && /data-act="wbDeleteWs"/.test(opened),
    '普通工作区展开菜单后要有改名/删除入口：' + opened.replace(/\s+/g, ' ').slice(0, 500));
  // ★ 菜单里**只有**这两项。从前还有「＋ 新会话」「工作目录…」「工作区权限…」，各有去处：
  //   前两项删除（见 wbWsMenuHtml 头注释），权限那项随整个模块删除。
  //   按按钮个数钉，是为了防"删了动作但忘了删按钮"这种半截状态。
  const menu = opened.match(/<div class="wb-menu" role="menu">([\s\S]*?)<\/div>/);
  assert.ok(menu, '工作区菜单要渲染出来');
  assert.equal((menu[1].match(/<button/g) || []).length, 2,
    '工作区菜单应恰好两项（重命名 / 删除），实际：' + menu[1].replace(/\s+/g, ' '));
  assert.ok(!/wb-menu-note/.test(menu[1]), '普通工作区的菜单里不该有"兜底工作区"那句说明');

  // 兜底工作区那一行：两项都禁用、且**没有** data-act（有 data-act 就等于还能点）
  await sandbox.window.App.wbToggleRowMenu('ws', 'wsp_demo_full');
  const defOpened = dom.state.html;
  const defMenu = defOpened.match(/<div class="wb-menu" role="menu">([\s\S]*?)<\/div>/);
  assert.ok(defMenu, '兜底工作区的菜单也要渲染出来（撤掉它，用户只会看到"这一行没有 ⋯"）');
  assert.equal((defMenu[1].match(/<button/g) || []).length, 2, '兜底工作区照样两项');
  assert.equal((defMenu[1].match(/disabled/g) || []).length, 2, '两项都要禁用');
  assert.ok(!/data-act="wbRenameWs"/.test(defMenu[1]) && !/data-act="wbDeleteWs"/.test(defMenu[1]),
    '禁用态不许带可点的 data-act');
  assert.ok(/wb-menu-note/.test(defMenu[1]) && /不能重命名、不能删除/.test(defMenu[1]),
    '禁用要**写出理由**（禁用了却不说为什么，等于让用户来问）：' + defMenu[1].replace(/\s+/g, ' '));

  assert.ok(/data-act="wbPickWorkspace"/.test(opened), '工作区行可点选（决定新对话建在哪）');
  // ★ 反向：「未分组」整块删除（0.21.9）。它不是一条工作区记录，却在权限上是一条暗门
  //   （服务端对它直接放行）。这里对**渲染结果**反向断言 —— 藏起来的那份会一直在。
  assert.ok(!/未分组/.test(defOpened), '树上不该再有「未分组」那一行');
  assert.ok(!/__ungrouped/.test(defOpened), '连它那个展开状态的 key 也不该再出现');
  assert.ok(/data-act="wbToggleRowMenu" data-a1="session" data-a2="ks_workbench_demo"/.test(opened),
    '会话行要有「⋯」入口');
});

await t('工作台 0.21.6：工作区权限整块删除 —— 界面上不再有任何档位 / 授权入口', async () => {
  // 这条是**删除**的钉子。删除最容易做成"藏起来"（CSS 一盖、条件一判，代码还留着），
  // 而藏起来的那份会一直在：改了不生效的入口比没有入口更糟（用户以为已经管住了）。
  // 所以这里对**渲染结果**与 **App 动作表**两边同时反向断言。
  const { dom, sandbox, calls } = await openWorkbench();
  for (const dead of ['wbToggleGrants', 'wbSessionGrants', 'wbGrantAdd', 'wbGrantRevoke',
    'wbWsVisibility', 'wbReloadGrants', 'wbGrantSubjectType', 'wbEditWsCwd']) {
    assert.equal(typeof sandbox.window.App[dead], 'undefined', '已删动作不该还挂在 App 上：' + dead);
    assert.ok(!new RegExp('data-act="' + dead + '"').test(dom.state.html),
      '已删动作不该出现在渲染结果里：' + dead);
  }
  for (const deadId of ['wb-gs', 'wb-gr', 'wb-gv']) {
    assert.ok(!new RegExp('id="' + deadId + '"').test(dom.state.html),
      '授权表单元素不该还在（面板删了更要删输入框）：' + deadId);
  }
  // 打开工作区菜单：里面不该冒出任何"权限"字样
  await sandbox.window.App.wbToggleRowMenu('ws', 'wsp_demo_full');
  const menu = dom.state.html.match(/<div class="wb-menu" role="menu">([\s\S]*?)<\/div>/);
  assert.ok(menu, '工作区菜单要渲染出来');
  assert.ok(!/权限/.test(menu[1]), '工作区菜单里不该再有「权限」项：' + menu[1].replace(/\s+/g, ' '));
  // 打开会话菜单：同理（从前这里是「工作区权限…」的就近入口）
  await sandbox.window.App.wbToggleRowMenu('session', WB_SID);
  const sm = dom.state.html.match(/<div class="wb-menu" role="menu">([\s\S]*?)<\/div>/);
  assert.ok(sm, '会话菜单要渲染出来');
  assert.ok(!/权限/.test(sm[1]), '会话菜单里不该再有「工作区权限…」：' + sm[1].replace(/\s+/g, ' '));
  // 一次都不该去打**工作区**授权接口（知识库的 ACL 是另一码事，仍在使用，不在此列）
  assert.ok(!calls.some((c) => /\/api\/workspaces\/[^/]+\/grants/.test(c)),
    '前端不该再请求工作区授权名单；实际调用里有：'
    + JSON.stringify(calls.filter((c) => /grants/.test(c))));
});

/* ── 模式（preset）：整块从界面上删除（0.21.9）─────────────────────────
 *
 * 这里曾有三条用例，全部围绕"模式"这个概念：
 *   · 「无会话空态 + 模式下拉」（0.21.6）
 *   · 「有会话时选择器条转为事实展示（所在工作区 + 已登记模式徽标）」（0.21.0）
 *   · 「会话没登记模式时如实说「未指定（跟随内核默认）」」（0.21.9 当轮）
 *
 * 用户 2026-10-08 裁定：「去掉标准模式等相关模式的内容」/「暂时先去掉标准模式等相关模式的内容吧」。
 *
 * ⚠️ 第三条的论证当时是**对的**（"不把现在的默认当成当时的模式填上去"），
 *    删掉它不是因为论证错了，而是因为**整个概念不在界面上了** —— 一个还在讨论
 *    "怎么显示才诚实"的控件，在它自己被撤掉之后就只剩维护成本。
 *    这套论证保留在下面这段注释里：将来要把模式加回界面，先把它读完再动手。
 *
 * 参考留档（当时的口径）：
 *   · 上游清单 `GET /api/kernel/presets` 报 `standard`(isDefault) / `ptc` / `minimal` / `cordis`；
 *   · 点＋建的会话记 `preset_id='standard'`（前端取 `presets.find(isDefault)`，随 body 提交）；
 *   · 初始化播种的「新会话」`preset_id=NULL` —— 它是**纯本地占位**（建它时内核可能还没接入），
 *     没有模式可记，界面上就"什么都不显示"。这正是用户看到"新建的有模式、默认那条没有"的由来。
 *   · **不许补记一个模式**：补的是"现在的默认"，不一定是当时的默认 = 伪造历史。
 *     要消不一致就**如实显示**「未指定（跟随内核默认）」—— 那正是被删掉的那版做法。
 *
 * 0.21.9 之后：默认会话本身也已删除（初始化只产生默认工作区，不再播种会话），
 * 所以"默认那条没有模式"这个具体症状**连前提都没有了**。
 */

await t('0.21.6：无会话空态（模式下拉与品牌页都已删，建会话只在树上的「＋」）', async () => {
  const { dom, calls } = await openWorkbench({ overrides: wbOverrides({
    ['GET /api/kernel/sessions']: { status: 200, body: { items: [], total: 0 } },
  }) });
  const html = dom.state.html;
  // ★ 反向断言：输入卡上方那个工作区下拉已删。
  //   它与左侧树是**两个改同一件事**（State.wb.wsActiveId）的入口 —— 在下拉里选 A、再从树上点 B，
  //   界面不告诉你哪个算数。现在只有一个入口：在哪一行点 ＋，就建在哪。
  assert.ok(!/id="wb-ws"/.test(html),
    '输入卡上方不该再有工作区下拉（0.21.6 删除：两个入口说同一件事）');
  assert.ok(!/wb-level-chip/.test(html), '输入卡左下的档位徽片也该没了（随权限模块删除）');
  assert.ok(!/id="wb-preset"/.test(html), '模式下拉已按用户裁定整块删除（0.21.9）');
  assert.ok(!/标准模式|PTC 模式|极简模式/.test(html), '界面上不许再出现任何模式名');
  assert.ok(/id="wb-effort"/.test(html) && />High</.test(html), '推理等级下拉来自模型目录 reasoning.efforts');
  assert.ok(calls.includes('GET /api/workspaces'), '要拉工作区树');
  assert.ok(!calls.includes('GET /api/kernel/presets'),
    '不该再去拉模式清单（0.21.9 删除：界面没有它了，拉回来也没人用）');
  // ★ 空态品牌页也已删除（用户：「搞成一套，不再搞什么会话前的样式」）——
  //   空态与有会话时**逐字同构**：页签 + 一句"开始一段对话" + 输入卡。
  assert.ok(!/wb-hero/.test(html), '空态品牌页不许再出现（那一套布局已整体删除）');
  assert.ok(!/wb-main is-empty|class="wb-main is-empty/.test(html), '`is-empty` 这个状态类也该没了');
});

await t('0.21.9：输入卡上方**整块**没有东西了（工作区徽片也删，模式早一步删）', async () => {
  const { dom } = await openWorkbench();
  const html = dom.state.html;
  assert.ok(!/id="wb-preset"/.test(html), '有会话时模式下拉不渲染（会话内不可改 —— 而且现在连这个控件都没了）');
  // ⚠️ 0.21.9 口径再次反转。这条用例上一版钉的是"会话所在工作区要显示"，
  //    依据是"会话一定属于某个工作区"。论证没错，但用户 2026-10-08 追加裁定：
  //    「工作区那一行信息也可以删掉（对话输入框上面一行）」。
  //    判据是**它买到的信息在别处已经有了**：会话在哪个工作区，左侧树上那一行是高亮的，
  //    名字就在那里 —— 再在输入卡上方复述一遍，代价是常驻一整行高度、把输入框与正文推远。
  //    所以现在这一行**整个不存在**：不只是没有徽片，是连行容器都没有。
  assert.ok(!/wb-chips/.test(html), '输入卡上方不该再有徽片行容器（整块删除）');
  assert.ok(!/class="[^"]*wb-chip[^"]*ghost[^"]*"[^>]*title="当前会话所在的工作区"/.test(html),
    '工作区徽片也不该在：' + html.replace(/\s+/g, ' ').slice(0, 500));
  // 反向：树上的高亮还在（"在哪儿"这件事仍有一个**唯一**的出口）。
  assert.ok(/wb-ws-row active/.test(html), '树上那一行的高亮要保留 —— 它现在承担"会话在哪"的显示');
  assert.ok(!/⚙|📁/.test(html), '徽片里那两个散装字形自然也不该再出现（⚙ / 📁）');
  // 模式徽片（0.21.9 删）：夹具里 `presetId=standard`，所以这条断言抓的就是"它又回来了"。
  assert.ok(!/>标准模式</.test(html) && !/· 标准模式/.test(html),
    '输入卡上方不许再有模式徽片：' + html.replace(/\s+/g, ' ').slice(0, 500));
  assert.ok(!/未指定（跟随内核默认）/.test(html), '连"未指定"那条如实说法也一并删了（概念整个不在界面上）');
  assert.ok(/id="wb-effort"/.test(html) && /value="high" selected/.test(html),
    '推理等级要同步到会话登记的值（reasoningEffort 回显）');
  // ⚠️ `.wb-chip.ghost` 那条 CSS 规则**必须还在** —— 输入卡里的模型徽片仍用它。
  //    这条断言防的是"删徽片行时顺手把这条规则也删了"那种过度删除。
  //    （从前这里必须绕开 `WB_CSS()` 改直接读文件，因为那个 const 当时声明在本处
  //      之后、会 TDZ；现在它已提到文件头部，两种写法都可以，这里保留直接读是为了
  //      顺手把注释剥掉 —— 样式断言命中注释里的示例文字是本项目栽过的坑。）
  const cssBare = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/\.wb-chip\.ghost\s*\{/.test(cssBare),
    '`.wb-chip.ghost` 规则要保留（输入卡里的模型徽片仍在用它）');
});

/* ── （已删除）「会话没登记模式时如实说「未指定（跟随内核默认）」」────────────────
 *
 * ⚠️ 这条用例的**论证是对的**，删它是因为**整个概念不在界面上了**（见上面那段模式删除说明）：
 *    一个还在讨论"怎么显示才诚实"的控件，在它自己被撤掉之后只剩维护成本。
 *    当时的做法与理由原样留在这里 —— 将来要把模式加回界面，先读它。
 *
 * 用户 2026-10-08 问：「新建的会话为什么默认标准模式，默认的新会话没有标准模式，这个模式不能修改吗」。
 * 三个答案里第二个是真的：初始化时那条**落脚会话**是平台播种的**纯本地占位**
 * （seedPlaceholderSession —— 建它的时候内核可能还没接入，平台不会把上游的默认值写死
 *  在自己这边），它没有 preset_id，于是界面上"什么都不显示"。空着会被读成"没查到 / 坏了"，
 * 所以当时改成如实说一句「未指定（跟随内核默认）」。
 *
 * ⚠️ 刻意**不把默认值填上**（presets.find(isDefault) 就在手边，填上去很容易）：
 *    那是**现在**问到的默认，填上去等于把"现在的"当成"当时的" —— 上游哪天换了默认值，
 *    这条会话的显示就跟着变，而它当时实际用的是另一个。用户在这三个选项里选的正是"如实说"。
 *
 * 0.21.9 之后：**播种会话本身也删了**（初始化只产生默认工作区），
 * 所以"默认那条没有模式"这个症状连前提都没有了。
 */


await t('工作台 0.21.6：过滤器按工作区名与会话标题过滤，不发新请求', async () => {
  const { dom, sandbox, calls } = await openWorkbench();
  // 0.21.2 起过滤框默认收起（节头的放大镜图标切换）—— 先展开再验
  // 0.21.7：那颗钮平时是隐形的（opacity:0），划过节头或用 Tab 聚焦才现身。
  // "隐形"用的是 opacity 而不是 display/visibility —— 后者会让它**从 Tab 序列里消失**，
  // 键盘用户就再也够不到过滤框了。见 style.css 里 .wb-sec-tools 那段说明。
  sandbox.window.App.wbToggleTreeFilter();
  await settle(calls);
  const before = calls.length;
  dom.byId('wb-tree-filter').value = '演示工作区';
  await sandbox.window.App.wbTreeFilter();
  await settle(calls);
  const html = dom.state.html;
  assert.ok(/演示工作区/.test(html), '命中的工作区要保留');
  assert.ok(!/另一个演示区/.test(html), '不命中的工作区要被过滤掉');
  assert.ok(!calls.slice(before).some((c) => /GET /.test(c)),
    '过滤是纯前端行为，不该发新的 GET（迟到的惰性加载除外则另计）');
});

/* ── 0.21.1：行内「⋯」菜单、工作区里建会话、模型与推理等级收口 ────────── */

await t('工作台 0.21.1：工作区「⋯」→「＋ 新会话」把会话建在**那一行**的工作区里', async () => {
  let sent = null;
  let created = false;
  const { dom, sandbox, calls } = await openWorkbench({ overrides: wbOverrides({
    ['POST /api/kernel/sessions']: {
      status: 201,
      onCall(o) { created = true; sent = o && o.body ? JSON.parse(o.body) : null; },
      body: { ok: true, session: { id: 'ks_new_in_ws', title: '新会话', kernelSessionId: 'up-9',
        workspaceId: 'wsp_demo_full', presetId: 'standard', reasoningEffort: 'high', kbIds: [] } },
    },
    // 服务端才是权威：建完之后列表里就该有这条新会话（挂在那个工作区下）。
    // "树上出现它"因此只可能来自**重拉 + 按 workspaceId 归组**，谁也伪造不了。
    ['GET /api/kernel/sessions']: {
      status: 200,
      get body() {
        return {
          items: [
            ...(created ? [{ id: 'ks_new_in_ws', title: '新会话', cwd: '', kernelSessionId: 'up-9',
              ownerUserId: 'u-demo', isMine: true, canManage: true, manageNeed: 'write',
              workspaceId: 'wsp_demo_full', eventCount: 0,
              createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' }] : []),
            { id: WB_SID, title: '工作台演示会话', cwd: '', kernelSessionId: 'up-1', eventCount: 3,
              ownerUserId: 'u-demo', isMine: true, canManage: true, manageNeed: 'write',
              workspaceId: 'wsp_demo_full',
              createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:10:00Z' },
          ],
          total: created ? 2 : 1,
        };
      },
    },
  }) });

  // 演示会话挂在 wsp_demo_full 下 → `wsActiveId` 默认就是它。这一行点「＋」要建在
  // **它自己**那个工作区里；若前端偷懒直接复用当前选中项而不认「点了哪一行」，
  // 这条就会在"选中的行 ≠ 点的行"时暴露出来（夹具里另一个工作区 wsp_demo_view 正是为此留着）。
  //
  // ⚠️ 0.21.6：不再需要先点开「⋯」——「＋」就在行上（用户要求：工作区右侧 ⋯、再右侧 ＋）。
  //    所以这里**不打开任何菜单**直接断言，顺带把"它必须常驻在 DOM 里"钉住。
  assert.ok(!/wb-menu/.test(dom.state.html), '前置：此刻不该有任何菜单开着');
  assert.ok(/data-act="wbNewSessionIn" data-a1="wsp_demo_full"/.test(dom.state.html),
    '不点开 ⋯ 就该看到「＋」并带着那一行的 id：' + dom.state.html.replace(/\s+/g, ' ').slice(0, 600));

  await sandbox.window.App.wbNewSessionIn('wsp_demo_full');
  await settle(calls);
  assert.ok(created, '要真的发出建会话请求');
  assert.equal(sent.workspaceId, 'wsp_demo_full', '会话要建在**那一行**的工作区里，实际：' + JSON.stringify(sent));
  // ⚠️ 0.21.12 修正：`presetId` **不再提交**（0.21.9 起）。
  //    「模式」那一整块从界面上拿掉了（用户裁定），于是前端没有一个"用户选了什么"可提交 ——
  //    服务端仍接受这个字段（缺省即 null），但请求体的形状**更窄**了。
  //    从前这里断言 `sent.presetId === 'standard'`，钉的是"模式随建会话一起提交"；
  //    那条口径随模式一起作废。改成**反向断言**：这个字段不该再出现 ——
  //    反着钉住它，等于把"模式已经撤出建会话流程"这个决定写进回归：
  //    谁将来把模式加回来（那时正确做法是**界面先有得选**，再提交），这条会立刻红、逼他回来读这段。
  //    见 71-app-workbench.js `wbNewSession` 里的 `body` 组装与它上面那段说明。
  assert.ok(!('presetId' in sent),
    '0.21.9 起建会话不再提交 presetId（模式已从界面撤出，没有"用户选了什么"可提交）：'
    + JSON.stringify(sent));
  assert.equal(sent.reasoningEffort, 'high', '推理等级一起提交');
  // 0.21.9：模型与 provider **必须成对**提交。上游 `session/selectModel` 只认非空字符串，
  // 缺 provider（或给 null）会让整个 POST /api/kernel/sessions 变成 500 ——
  // 表现就是"新建会话报错"。夹具里目录分组的 provider 键在这一版要按**真实形状**给。
  assert.equal(sent.provider, 'stub', 'provider 要一起提交，实际：' + JSON.stringify(sent));
  assert.equal(sent.model, 'stub-deterministic', 'model 要一起提交');
  assert.ok(!/wb-menu/.test(dom.state.html), '菜单里的动作一执行就收起（留着它盖在树上只是噪音）');
  // 新会话要**出现在那一行的工作区下**：这同时钉住两件事 ——
  // ① 建完真的重拉了列表（不做本地乐观插入）；② 那一行是展开的（收起的话用户看不到新会话，会以为没建成）。
  const tree = dom.state.html;
  // 0.21.7：节点名前面的 📁 emoji 换成内联 SVG，所以"哪一行"改用 .wb-ws-label 定位
  //（它包的才是工作区名本身；用裸名字找会被别处的同名文本误命中）。
  const wsAt = tree.indexOf('wb-ws-label">演示工作区');
  // ⚠️ 0.21.12：`wb-session-title` 那一格还挂着 `title` 属性（0.21.9 的悬停提示），
  //    所以不能用 `wb-session-title">新会话` —— 那要求类属性后紧跟 `>`，恒不匹配。
  //    这里仍要**定位到新会话那一条**（而不是随便一条会话行），判据改成
  //    "类属性之后允许还有别的属性，然后就是 `新会话`"。
  const newAt = tree.search(/wb-session-title"[^>]*>新会话</);
  const viewAt = tree.indexOf('wb-ws-label">另一个演示区');
  assert.ok(wsAt >= 0 && newAt > wsAt, '新会话要挂在演示工作区节点下：' + tree.replace(/\s+/g, ' ').slice(0, 600));
  assert.ok(viewAt < 0 || newAt < viewAt, '而且要挂在**它自己那个**工作区下（不能串到下一个节点去）');
});

await t('0.21.9 工作区行的「⋯」菜单渲染在**行内部** —— 它的定位祖先是那一行', async () => {
  // 这条钉的是一个"点了完全没反应"的真缺陷（用户报的"默认工作区那一行三个点"）：
  //   `.wb-menu` 是 `position:absolute; top:100%`，定位祖先是**最近的有 position 的祖先**。
  //   全侧栏里只有 `.wb-ws-row` / `.wb-session` 带 `position:relative`。
  //   0.21.9 之前工作区菜单渲染在行**外面**、挂在 `.wb-ws` 上（没有 position）——
  //   于是定位祖先一路退到视口（初始包含块），`top:100%` 折算成整页高度：菜单被画到
  //   视口下方再被 `.wb-tree` 的 overflow 裁掉。点 ⋯ 看起来毫无反应。
  //   ⚠️ 会话行的菜单一直是正常的，就因为它渲染在 `.wb-session` 里面 —— 差的就是这一层。
  const { dom, sandbox, calls } = await openWorkbench();
  // ⚠️ 0.21.12 修正：改开**非兜底**工作区（`wsp_demo_view`）的菜单。
  //    从前这里开的是 `wsp_demo_full`，而夹具把它标成 `isDefault: true`（见 4345 附近的注释）。
  //    兜底工作区的两项是**禁用且不带 `data-act`** 的（0.21.9 的设计：摆出来、灰掉、写清理由，
  //    见 wbWsMenuHtml）—— 于是下面"菜单里要有 wbRenameWs / wbDeleteWs"永远为假，
  //    这条用例其实**从来没验到过菜单内容**，只验到了"菜单在行内"这一半。
  //    这里要钉的是**定位祖先**，与"哪一行"无关；挑普通工作区才能让内容断言也真的成立。
  //    （兜底工作区那份"禁用 + 写理由"由上面「工作区树渲染」那条用例专门钉住，不重复。）
  await sandbox.window.App.wbToggleRowMenu('ws', 'wsp_demo_view');
  await settle(calls);
  const html = dom.state.html;
  // 定位**那一行**：先找工作区名，再回退到最后一次出现的行开头 —— 不靠"第一行就是它"，
  // 夹具里有多个工作区，按顺序猜会在别人改动夹具后静默指错行。
  const nameAt = html.indexOf('wb-ws-label">另一个演示区');
  const rowAt = html.lastIndexOf('<div class="wb-ws-row', nameAt);
  // ⚠️ 0.21.12 修正：必须**从 rowAt 往后找**那个菜单。全文档 `indexOf('<div class="wb-menu')`
  //    会命中**第一处**菜单 —— 树上若别的行先开着菜单（或会话行自带一处），
  //    拿到的就是别人的菜单：深度与 `menu-open` 都在错误的对象上量，
  //    断言变成"随便哪一行对了就行"，本用例要钉的"就是这一行"当场失效。
  const menuAt = html.indexOf('<div class="wb-menu', rowAt);
  assert.ok(rowAt >= 0 && menuAt > rowAt, '开关打开后应出现工作区行的菜单');
  // ⚠️ 期望值是 **2**，不是 1。`divDepthAt` 从 `from` 起数、**把 target 自己那个 `<div` 也算进去**，
  //    所以语义是"目标 `<div` 是那个容器的**第几层**"：容器自己 = 1，直接子级 = 2。
  //    写 1 的话，正确的结构（菜单在行内）报 2 被判红，而**兄弟层**（坏掉的那种：
  //    行先闭合、菜单再开）算出来正好是 1 —— 于是这条断言把"对的"和"错的"**判反了**：
  //    它会放过坏结构、卡住好结构。这个 1/2 之差必须与下面 `divDepthAt` 的注释一致。
  assert.equal(divDepthAt(html, rowAt, menuAt), 2,
    '菜单必须是那一行的**直接子级**（= 深度 2；1 表示挂在了行的兄弟层，正是坏掉的那种）：'
    + html.replace(/\s+/g, ' ').slice(rowAt, rowAt + 500));
  assert.ok(/data-act="wbRenameWs" data-a1="wsp_demo_view"/.test(html), '菜单里要有「重命名工作区」');
  assert.ok(/data-act="wbDeleteWs" data-a1="wsp_demo_view"/.test(html), '菜单里要有「删除工作区」');
  assert.ok(/menu-open/.test(html.slice(rowAt, menuAt)), '菜单开着时行要带 menu-open（否则 ⋯ / ＋ 会跟着隐掉）');

  const css = WB_CSS();
  assert.ok(/\.wb-ws-row\s*\{[^}]*position:\s*relative/.test(css),
    '行必须带 position:relative —— 菜单的定位祖先就是它，这条掉了菜单就会飞到视口下方');
  assert.ok(/\.menu-open\s+\.wb-row-more/.test(css),
    'CSS 的选择器要用 JS 真正发出去的那个类名（menu-open）');
  // ⚠️ 0.21.12 修正：这一条必须先**剥掉注释**再判。
  //    `wb-menu-open` 这个错名字在 style.css 里确实出现，但只出现在**解释它是错的**那段注释里
  //    （1571 行：「类名对不上：JS 给行加的是 `menu-open`，这里从前写 `.wb-menu-open`」）。
  //    注释不算样式表的一部分 —— 拿带注释的原文去扫，等于禁止把这次修复写进文档，
  //    而那段注释恰恰是这个坑唯一留下的记录。判据只该针对**规则**。
  const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/wb-menu-open/.test(cssBare),
    '反向：`wb-menu-open` 这个对不上的名字不许再出现在**样式规则**里'
    + '（它让那条规则从来没生效过）。注释里说明它曾经是错的，不算违规。');
});

await t('0.21.9 左栏悬停提示：每一格都有一句，且只写**功能本身**', async () => {
  // 这条钉的是用户报的"左侧所有鼠标划过有时候没办法弹出、另外鼠标划过弹出的只写功能本身"。
  // 逐字拆开是两件事，两件都是**可见的**，所以只能在渲染结果上钉：
  //
  // ① "有时候弹不出来" = 有的格子挂了提示、有的没挂。**会话行最典型**：它是树里面积最大的
  //    一块，此前整行没有一句提示 —— 划过名字、划过"N 事件 · 5 分钟前"都不弹，只有右上
  //    那颗小小的「⋯」有。于是同一棵树上"划过有的地方弹、有的地方不弹"。
  //    ⚠️ 断言写成"**每一个**文本格都带提示"（计数相等），而不是"存在某个带提示的" ——
  //    后者在"只补了一格"时照样绿，正是这次要防的半截状态。
  //
  // ② "只写功能本身" = 提示不许把菜单内容抄一遍。工作区 ⋯ 从前写着"重命名工作区 / 删除工作区"，
  //    而菜单内容已经改了两轮（＋ 提走、权限项删除）—— 抄的那份不会跟着变，用户看到的就是
  //    "功能变更了描述还是以前的"。所以这里对旧文案做**反向**断言。
  const { dom } = await openWorkbench({ overrides: wbOverrides({
    ['GET /api/kernel/sessions']: {
      status: 200,
      body: { items: [{ id: WB_SID, title: '工作台演示会话', cwd: '', kernelSessionId: 'up-1',
        ownerUserId: 'u-demo', isMine: true, canManage: true, manageNeed: 'write',
        workspaceId: 'wsp_demo_full', eventCount: 3, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:10:00Z' }], total: 1 },
    },
  }) });
  const html = dom.state.html;

  // ① 会话行的两个文本格（标题 / 副行）一个都不许漏 —— 它俩是"划过一行"命中面积的主体
  for (const cls of ['wb-session-title', 'wb-session-meta']) {
    const all = (html.match(new RegExp('<div class="' + cls + '"', 'g')) || []).length;
    const hinted = (html.match(new RegExp('<div class="' + cls + '" title="打开这个会话"', 'g')) || []).length;
    assert.ok(all >= 1, '夹具里要有会话行才谈得上提示：' + cls);
    assert.equal(hinted, all, '每一条会话行的 ' + cls + ' 都要带悬停提示（少了就是"划过不弹"）');
  }

  // ① 展开三角：它是每行**最左**的一格，鼠标从左边扫进来最先落到它身上；它此前没有提示。
  //    夹具里有两个工作区就至少有两个三角 —— 按"每一个都有提示"钉（不是"存在某个有提示的"，
  //    后者在只补了一行时照样绿）。
  const carets = (html.match(/<span class="wb-ws-caret"/g) || []).length;
  const caretHints = (html.match(/<span class="wb-ws-caret"[^>]*title="展开或收起"/g) || []).length;
  assert.ok(carets >= 2, '夹具里要有两个工作区行（两个三角）');
  assert.equal(caretHints, carets, '每一个展开三角都要带悬停提示');
  // 0.21.9 反向：那个"未分组的会话数"徽片随未分组桶一起删了 —— 它就是这一行里
  // 唯一"看得出有意义却什么都不弹"的一格，而那一行本身已经不存在了。
  assert.ok(!/未分组的会话数/.test(html), '未分组的数字徽片随那一行一起删掉');

  // 工作区名的提示显示**工作目录**（0.21.9 第二轮，用户裁定原话「默认工作区鼠标划过显示个路径
  // 就可以啦」—— 推翻了前一轮"只写功能本身"的做法：cwd 是这一行唯一有实质影响的事实属性）。
  // 夹具里一个有 cwd、一个没有 —— 两种情形都钉住：有 → 显示路径；没有 → **如实说**没设
  //（不能渲染成空白，空白看起来像"没读到数据"）。
  assert.ok(/wb-ws-name"[^>]*title="C:\/demo"/.test(html), '有 cwd 的工作区，悬停显示路径');
  assert.ok(/wb-ws-name"[^>]*title="未设置工作目录"/.test(html), '没有 cwd 的工作区，如实说没设');
  assert.ok(!/title="选择这个工作区"/.test(html),
    '工作区名不再用"选择这个工作区"当提示（用户点名要路径）');

  // ② 正向：⋯ 的提示就是功能本身
  assert.ok(/data-act="wbToggleRowMenu" data-a1="ws"[^>]*title="更多操作"/.test(html),
    '工作区 ⋯ 的提示写"更多操作"');
  // ② 反向：把菜单内容抄进提示的旧文案不许回来
  assert.ok(!/重命名工作区 \/ 删除工作区/.test(html),
    '提示里不许罗列菜单项 —— 菜单一改它就过期（用户原话："功能变更了描述还是以前的"）');
});

await t('工作台 0.21.9：「未分组」整块删除 —— 树上每一行都是一条真实的工作区', async () => {
  // 这条是**删除**的钉子（做法与 0.21.6 删掉工作区权限那一组一致）。
  // 未分组 = `workspace_id IS NULL`，它没有 id / cwd / 名字，删不得也改不了名，
  // 却在权限上是一条暗门（服务端对它直接放行）。删掉它之后：
  //   · 树上不该再有那一行，也不该再有它的展开状态 key；
  //   · "新建会话"不再有"建到未分组"这个落点（`wbNewSessionIn('')` 直接不做事）。
  const { dom, sandbox, calls } = await openWorkbench();
  const html = dom.state.html;
  assert.ok(!/未分组/.test(html), '树上不该再有「未分组」那一行');
  assert.ok(!/__ungrouped/.test(html), '它那个展开状态的 key 也不该再出现');
  assert.ok(!/data-act="wbNewSessionIn" data-a1=""/.test(html),
    '不再有"建进未分组"的入口（空 id 的 ＋）');

  // 空 id 是**没有语义**的（从前是"未分组"）—— 这个动作必须什么都不做，
  // 而不是把 `wsActiveId` 清掉（那会让接着建的会话落到服务端的兜底工作区里，
  // 用户还没机会察觉自己刚点的那一下被静默接受了）。
  const before = dom.state.html;
  const n = calls.length;
  await sandbox.window.App.wbNewSessionIn('');
  await settle(calls);
  assert.equal(dom.state.html, before, 'wbNewSessionIn("") 不该改变任何渲染结果');
  assert.equal(calls.length, n, '更不该发出建会话请求');
});

await t('工作台 0.21.9：会话框里是一对选项卡（对话 / 轨迹），默认停在「对话」；右栏不再是选项卡', async () => {
  // 这一版的样子由用户**两次**裁定合起来才是设计 —— 中间的半成品极易被当成设计，
  // 所以两条都留在这里：
  //   ①「轨迹要显示在会话内容中吗，不能在右侧显示一个选项卡对话、轨迹分开（参考原生 dsh）」
  //      → 拆：消息流只留正文，工具卡/推理/回执整体搬出去；
  //   ②「轨迹不要放到右侧栏，放到会话框中（会话框中选项卡对话、轨迹）」
  //      → 放**回会话框**。第一版放到右栏是错的：轨迹是这个会话的内容，
  //        而右栏装的是"会话旁边的材料"（用量 / 产物）。
  const { dom, sandbox } = await openWorkbench();
  let html = dom.state.html;

  const tabs = html.match(/<div class="wb-tabs"[^>]*>[\s\S]*?<\/div>/);
  assert.ok(tabs, '会话框要有一对选项卡（这是本版"拆开"那一步）');
  // ⚠️ `class="wb-tab` 这个正则**会把容器自己算进去**：容器是 `class="wb-tabs"`，
  //    它以 `wb-tab` 开头，所以旧写法（`/class="wb-tab/g`）恒多出 1 —— 数出来是 3。
  //    这不只是"数字要改"：多出来的那 1 与页签个数无关，页签真少一个时它照样是 3，
  //    于是这条断言**测不出它要测的东西**。
  //    正确写法要同时满足两点（两者缺一都会得到错的数）：
  //      · 类名后面**不能再有别的类名字符**（排除容器 `wb-tabs`）→ 用 `(?=[" ])`;
  //      · **允许**选中态那一个多带 ` on`（否则只会数到 1 —— 它已经踩过一次）。
  assert.equal((tabs[0].match(/class="wb-tab(?=[" ])/g) || []).length, 2, '恰好两个页签');
  assert.ok(/data-act="wbViewTab" data-a1="chat"/.test(tabs[0]), '第一个是「对话」');
  assert.ok(/data-act="wbViewTab" data-a1="trace"/.test(tabs[0]), '第二个是「轨迹」');
  assert.ok(/class="wb-tab on"[^>]*data-act="wbViewTab" data-a1="chat"/.test(html),
    '默认停在「对话」—— 用户按下发送之后要看的就是回答');

  // ★ 反向：右栏**不再是**选项卡。0.21.9 第一版把它摆在那里，被用户否了；
  //   不钉这一条的话，"两边都留着"也能全绿（而那正是"两个入口改同一件事"的老毛病）。
  assert.ok(!/data-act="wbRailTab"/.test(html), '右栏不该再有选项卡（轨迹属于会话框，不属于会话旁边）');
  assert.ok(!/id="wb-rail-body"/.test(html), '右栏那个 tab 体也不该再存在');

  // ★ 位置：这两个页签要在**主区里**、且在消息流**之前**（贴着会话框的顶）。
  //   它是"这个会话框的页签"，不是"整页的导航" —— 挪到主区外面或流下面，读起来就变了。
  const mainIdx = html.indexOf('<section class="wb-main');
  const tabsIdx = html.indexOf('class="wb-view-tabs"');
  const streamIdx = html.indexOf('id="wb-stream"');
  assert.ok(mainIdx >= 0 && tabsIdx > mainIdx, '选项卡要在主区（.wb-main）之内');
  assert.ok(streamIdx > tabsIdx, '选项卡要在消息流之前（在会话框顶部）');

  sandbox.window.App.wbViewTab('trace');
  html = dom.state.html;
  assert.ok(/class="wb-tab on"[^>]*data-act="wbViewTab" data-a1="trace"/.test(html), '点击后选中态要跟着走');
  assert.ok(/class="wb-trace"/.test(html), '切到「轨迹」要渲染轨迹');
  // 轨迹是按回合读的：每一条用户提问都要成为一段的标题（少了它，下面那堆工具卡
  // 就不知道属于哪一问）。夹具里的演示会话有两条用户消息。
  assert.ok(/<div class="wb-trace-turn">/.test(html) && /历史上的一个问题/.test(html),
    '轨迹里要有按提问分段的标题：' + html.replace(/\s+/g, ' ').slice(-500));
  // ★ 反向：切到轨迹时**对话正文不该还在**（否则就是两个视图叠在一起，
  //   而那正是"分开"这件事要消掉的东西）。
  assert.ok(!/class="wb-msg user"/.test(html), '轨迹页签下不该同时摊着对话气泡');

  // 切回来：两个页签是同一份数据的两个视图，来回切必须都还原得回来
  sandbox.window.App.wbViewTab('chat');
  assert.ok(/class="wb-msg user"/.test(dom.state.html), '切回「对话」要恢复正文');
  assert.ok(!/class="wb-trace-turn"/.test(dom.state.html), '对话页签下不该同时摊着轨迹');

  // ── 空态（没有会话、没有消息）**照样摆页签** ───────────────────────────
  // ⚠️ 0.21.9 口径反转。从前这里是"空态不摆页签"，理由是"那时主区是品牌空态页 +
  //    居中输入卡，摆一排页签会让空态看起来像一个没有内容的会话"。
  //    用户随后裁定删掉整套空态布局：「搞成一套，统一新建会话后的样式，
  //    不再搞什么会话前的样式，增加复杂性」。
  //    于是**页签恒渲染** —— 它不是"有内容才有意义"的东西，它是这个会话框的骨架。
  //    不画它反而会得到"一个没有页签的会话框"，那才是用户说的"两套样式"。
  runInApp(sandbox, 'State.wb.sessionId = null; State.wb.msgs = []; render();');
  const emptyHtml = dom.state.html;
  assert.ok(!/wb-hero/.test(emptyHtml), '空态品牌页已整体删除');
  assert.ok(/class="wb-view-tabs"/.test(emptyHtml),
    '空态也要摆页签 —— 主区只有一套布局，有没有会话**逐字相同**');
  assert.ok(/开始一段对话/.test(emptyHtml),
    '空的消息流里要有一句实话（空白会被读成"没加载出来"）');
});

await t('工作台 0.21.9：数据没回来之前**不画工作台**（首屏不闪"未分组 + 居中输入卡"）', async () => {
  // 用户 2026-10-08：「整个页面在刷新过程中可以隐约看到左侧有未分组、右侧会话框显示到中间
  // （还有模式可选），感觉很乱」。那不是另一个页面，是**同一页按"空状态"先画了一遍**：
  // sessions 还空着、wsActiveId 还是 null → 树按"停在未分组上"渲染、主区按"没有会话"
  // 渲染品牌页 + 居中输入卡；数据一到整页换装。
  // 修法是 `State.wb.ready`：第一次加载跑完之前，这一屏什么都不画。
  const { dom, sandbox } = await openWorkbench();
  assert.ok(/wb-ws-row/.test(dom.state.html), '前提：数据回来后正常工作区树要渲染');

  // 拨回"从没加载过"＝刷新后到数据回来之间那一帧
  runInApp(sandbox, 'State.wb.ready = false; render();');
  const html = dom.state.html;
  assert.ok(/wb-boot/.test(html), '这一帧要渲染加载态');
  assert.ok(!/wb-hero/.test(html), '不该出现空态品牌页（它已整体删除）');
  assert.ok(!/wb-ws-row/.test(html), '更不该先画出一棵树');
  assert.ok(!/wb-compose-wrap/.test(html), '输入卡也不该先画出来（数据一到它会跳到别处）');
  assert.ok(!/id="wb-preset"/.test(html), '模式下拉同理（用户报的"还有模式可选"就是它）');
  // ⚠️ 0.21.12 修正：这里原来断言"整个 `.wb` 网格都不该出现"，与实现不符 ——
  //    加载态**就是**画在 `.wb` 里的：`pageWorkbench` 返回
  //    `<div class="wb"><div class="wb-boot">…</div></div>`，而 style.css 的 `.wb-boot`
  //    带着 `grid-column: 1 / -1`，**明确说明它是那个三列网格里的一格**（不许改成
  //    absolute 悬浮，否则网格会按"只有 boot 这一格"重排、数据到了又跳一次）。
  //    所以"外壳在不在"根本不是判据 —— 判据是**里面有没有画出可用状态的东西**。
  //    下面三条（品牌页 / 树 / 输入卡）已经逐条钉住了这件事，这里补一条更根本的：
  //    加载态的那一格里**只有** `.wb-boot` 一个孩子，不该有任何工作台零件。
  const bootOnly = (html.match(/<div class="wb">([\s\S]*)<\/div>$/) || [])[1] || '';
  assert.ok(/wb-boot/.test(bootOnly), '加载态该画在 `.wb` 网格里（`.wb-boot` 是它的一格）');
  assert.ok(!/wb-side|wb-main|wb-rail|wb-compose/.test(bootOnly),
    '但那一格里只许有加载提示，不许有任何工作台零件（左栏 / 主区 / 右栏 / 输入卡）');

  // 拨回来，别把这份状态漏给后面的用例
  runInApp(sandbox, 'State.wb.ready = true; render();');
  assert.ok(/wb-ws-row/.test(dom.state.html), '恢复后工作台照常渲染');
});

await t('工作台 0.21.6：没有 session:write 时「＋」是禁用态并写明原因（不是点了才 403）', async () => {
  // 判据是组织角色推出来的 `session:write`（viewer 没有）。摆一个点了必然 403 的按钮，
  // 用户读作"系统坏了" —— 所以这里是**禁用 + 写明原因**，且不许带可点的 data-act。
  // ⚠️ 权限矩阵是**布尔对象**（`perms.session.write`），不是数组；写成数组会把 read 也抹掉，
  //    于是落地页直接回落到概览 —— 那条路测到的是"另一个页面"，不是本用例要钉的东西。
  const perms = wbMemberPerms();
  perms.session.write = false;
  perms.session.execute = false;
  const { dom } = await openWorkbench({ permissions: perms });
  const html = dom.state.html;
  assert.ok(/wb-ws-row/.test(html), '前提：本用例要停在工作台上（有 session:read 就进得来）');
  // 0.21.9 收短了禁用态文案，但仍以"不能新建会话"开头、原因跟上 —— 钉住"原因必须在"。
  assert.ok(/<button class="wb-row-add" disabled title="不能新建会话：当前角色没有 session:write"><svg class="wb-ico sm"/.test(html),
    '「＋」要禁用并写明缺哪个能力，图标走统一的内联 SVG（不再是散装字形）：'
    + html.replace(/\s+/g, ' ').slice(0, 700));
  assert.ok(!/data-act="wbNewSessionIn"/.test(html),
    '禁用态不能带可点的 data-act（否则点了才知道不能建）');
});

await t('工作台 0.21.1：模型与推理等级挨在一起（同一个会话的两个设置，不该拆在两处）', async () => {
  const { dom } = await openWorkbench();
  const html = dom.state.html;
  // 0.21.2：两个选择器都在输入卡右下（.wb-card-foot → .wb-foot-right），圆形发送钮之前
  const at = html.indexOf('wb-card-foot');
  const end = html.indexOf('wb-send');
  assert.ok(at >= 0 && end > at, '输入卡底部要在');
  const foot = html.slice(at, end);
  assert.ok(/id="wb-model"/.test(foot), '模型下拉要在输入卡右下');
  assert.ok(/id="wb-effort"/.test(foot), '推理等级也要在同一格');
  assert.ok(/id="wb-model"[\s\S]*id="wb-effort"/.test(foot), '顺序：模型 → 推理等级（等级是模型的属性）');
  // 0.21.7：这里原来断言「已归因模型 / 模型未归因」徽标与模型同排。徽标整块删除
  //（用户："模型未归因又是个什么…右侧选择哪个模型会话就绑定哪个模型不行吗"）——
  // 删的理由是它解释的那个问题**已经不存在了**：选择器就是会话的绑定项（选中的 == 绑定的）。
  // 换成正反两条：foot 里不许再有那个徽标；而"选中立即登记到会话"这句话必须写在
  // 下拉的 title 里 —— 那是归因口径唯一需要让用户知道的一句。
  // 0.21.9（用户问"描述是否准确"）：查证后把那句话改成**两种情形都成立** ——
  //   有会话：change 立刻 POST …/model 落库；没会话：什么都不登记、只作为新会话的默认。
  //   从前的"选中即登记到本会话"在**新建会话时是假的**（那时还没有会话可登记），
  //   所以这里除了"登记"这句，还要钉住"没有会话时"那半句 —— 两条缺一条就是又写偏了。
  assert.ok(!/已归因模型|模型未归因/.test(foot),
    '不再有「已归因 / 未归因」徽标，实际：' + foot.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(/选中立即登记到会话/.test(foot),
    '模型下拉的 title 要写明"选中立即登记到会话"（用户因此知道选的就是算账用的那个），实际：'
    + foot.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(/还没有会话时/.test(foot),
    'title 还要说清"没有会话时"的行为（从前那句在新建会话时不成立）：'
    + foot.replace(/\s+/g, ' ').slice(0, 300));
  // 全页只许有一份模型下拉（否则"这个会话跑在哪个模型上"有了两个说法）
  assert.equal((html.match(/id="wb-model"/g) || []).length, 1, '模型下拉全页只有一份');
});

/* ── 两枚下拉的样式颜色（0.21.9，用户 2026-10-08）──────────────────────────
 *
 * ⚠️ 这条用例改过一次**判据本身**，过程要留着 —— 它是本项目"改错地方"的标本。
 *
 * 用户第一句：「对话框大模型及推理等级下拉框样式颜色有问题重新修改」。
 * 我把它读成"箭头有问题"，查证出箭头的三个缺陷（位图写死颜色 / 暗色主题看不清 /
 * `:disabled` 时箭头不跟着淡 / `.chip-ctl` 是死类），并写了下面①②③那几条断言。
 *
 * 用户的回应是：「改的锤子啊，好好看看下拉框颜色 看什么颜色 背景色 字体颜色」——
 * 箭头那一轮**根本没碰到他看到的问题**。他指的是这两枚下拉**实际落在什么底色、
 * 什么字色上**。查证（改前）：
 *   `.wb-chip.ghost { background: transparent; color: var(--text-dim) }`
 *   → `.wb-chip select { background: transparent; color: inherit }`
 *   → 落进 `.wb-card { background: var(--bg-panel) }`
 * 整块**透明**：两枚下拉与卡片背景逐像素同色、字色比正文淡一档 ——
 * 在用户眼里是"两段穿插在卡片里的小灰字"，不是控件。
 *
 * 所以这条用例现在**多一组断言（⑤底色与字色）**，把"看得见的一枚控件"钉住：
 *   底必须**不等于**卡片底（否则又回到逐像素同色），字色必须**不是** --text-dim。
 * 箭头那几条**保留**（它们钉的是另外几个真缺陷，改动本身没错），只是不再是重点。
 *
 * ⚠️ 断言分两半：**结构**（箭头是元素、不是位图）与**样式**（颜色不写死、底不透明）。
 *    只钉样式的话"把位图颜色改成变量"也能过，而那解决不了暗色主题（变量进不了 data URI）。
 */
await t('输入卡两枚下拉：箭头随 currentColor，且底色与字色不再"与卡片同色的小灰字"', async () => {
  const { dom } = await openWorkbench();
  const html = dom.state.html;
  const at = html.indexOf('wb-card-foot');
  const foot = html.slice(at, html.indexOf('wb-send', at));

  // ① 箭头必须是**元素**。判据：`.wb-sel-caret` 出现在两枚下拉各自之后。
  const carets = (foot.match(/<span class="wb-sel-caret"/g) || []).length;
  assert.equal(carets, 2,
    '模型与推理等级各要有一枚箭头元素（这正是"颜色能跟随主题"的实现方式）：' + foot.slice(0, 600));
  assert.ok(/id="wb-model"[\s\S]*wb-sel-caret/.test(foot),
    '模型的箭头要在它自己的 select 之后（顺序反了会被绝对定位成"飘在左边"）');
  assert.ok(/id="wb-effort"[\s\S]*wb-sel-caret/.test(foot),
    '推理等级的箭头同理，绑在**它自己**那枚 select 上');
  // 箭头是纯装饰：可读语义由 select 自己的 aria-label 给，读屏器不该再念一遍"下箭头"。
  assert.equal((foot.match(/<span class="wb-sel-caret" aria-hidden="true">/g) || []).length, 2,
    '箭头要 aria-hidden —— 它是装饰，语义由 select 的 aria-label 承担');

  const css = WB_CSS().replace(/\/\*[\s\S]*?\*\//g, '');
  // ② 位图箭头必须**拆掉**。这是本用例的核心：位图 + 写死颜色 = 暗色主题看不清，
  //    且 disabled 时不会跟着淡。留着它（哪怕调了颜色）问题就还在。
  const selRule = (/\.wb-chip select\s*\{([^}]*)\}/.exec(css) || [])[1] || '';
  assert.ok(selRule, 'style.css 里要有 .wb-chip select 规则');
  assert.ok(!/background-image/.test(selRule),
    '下拉的箭头不许再走 background-image —— 那是独立资源、取不到 currentColor，'
    + '颜色只能写死，暗色主题下必然不清（这正是"颜色有问题"的根因）: ' + selRule);
  // 反向：那个写死的中灰不该在**用到颜色的地方**留下痕迹。
  // ⚠️ 0.21.12 修正：这个值**已经升格成调色板里的一档**（`--text-faint: #8b949e`）。
  //    所以"样式表里出现这个十六进制"不再是过错 —— 它现在正是"颜色集中在一处"的正确形态。
  //    原先的全表扫会把它连定义一起判红。
  //
  //    ⚠️ 剥离范围必须是**所有** `:root…` 块，不能只剥 `:root {`：
  //    这个值定义在 `:root[data-theme="light"] { … }` 里（第一处 `:root {` 只放
  //    字体与圆角，不放颜色）。只剥裸 `:root {` 的话，token 定义仍在视线内 → 假红。
  //    选择器形如 `:root` / `:root[data-theme=…]`，统一用 `:root[^{]*\{` 匹配其头部。
  const cssNoVars = css.replace(/:root[^{}]*\{[^{}]*\}/g, '');
  assert.ok(!/#8b949e|%238b949e/i.test(cssNoVars),
    '写死的箭头色 #8b949e 只能作为调色板变量（--text-faint）的定义出现；'
    + '别处再写一遍就是"取不到 currentColor 只好写死"的老毛病回来了');
  assert.ok(/--text-faint:\s*#8b949e/i.test(css),
    '这个值应当保留为调色板里的一档（--text-faint），而不是被删掉');

  // ③ 箭头元素：跟随 currentColor 靠的是"不写颜色"，且必须 pointer-events:none
  //    （否则点箭头落在 SVG 上、下拉不展开 —— 表现是"点箭头没反应"）。
  const caretRule = (/\.wb-chip \.wb-sel-caret\s*\{([^}]*)\}/.exec(css) || [])[1] || '';
  assert.ok(caretRule, '要有 .wb-chip .wb-sel-caret 规则');
  assert.ok(/pointer-events:\s*none/.test(caretRule),
    '箭头必须 pointer-events:none —— 否则点它不会展开下拉（点文字才开）: ' + caretRule);
  assert.ok(/position:\s*absolute/.test(caretRule),
    '箭头要绝对定位贴右端（否则它会挤在文字后面、把 select 撑宽）: ' + caretRule);
  // 绝对定位需要一个定位祖先 —— 缺了它箭头会飞到整个页面右上角。
  const ctlRule = (/\.wb-chip\.ghost\.chip-ctl\s*\{([^}]*)\}/.exec(css) || [])[1] || '';
  assert.ok(/position:\s*relative/.test(ctlRule),
    '两枚下拉的容器要 position:relative，给箭头当定位祖先: ' + ctlRule);

  // ④ 死类：`.chip-ctl` 必须在样式表里**有规则**（从前一条都没有）。
  assert.ok(/\.chip-ctl/.test(css), '`.chip-ctl` 不许再是死类（HTML 里写着就得有人管）');
  // ⚠️ 而且必须是三类选择器：这两枚徽片同时带 .wb-chip 与 .ghost，
  //    而 `.wb-chip.ghost` 的特异度是 (0,2,0) —— 单写 `.chip-ctl` (0,1,0) 会被它压过，
  //    padding 改了等于没改（本项目在 `.wb-sideitem` 下划线那条上栽过同样的坑）。
  assert.ok(/\.wb-chip\.ghost\.chip-ctl/.test(css),
    '`.chip-ctl` 的规则要写成三类（.wb-chip.ghost.chip-ctl）—— 否则被 .wb-chip.ghost 压过，'
    + '看着"加了样式没生效"');
  // ⑤ 另一个死类：`wb-model-chip` 样式表里没有、也没人引用，已从 HTML 删掉。
  assert.ok(!/wb-model-chip/.test(html),
    '`wb-model-chip` 是死类（样式表里没有它），不许再出现在标记里 —— '
    + '要区分两枚下拉请用 #wb-model / #wb-effort 的 id');
  assert.ok(!/\.wb-model-chip\s*\{/.test(css),
    '也不许反过来补一条只有这个类名的规则（那只是为了让它"看起来有人管"）');

  // ⑥ ★ 底色与字色 —— 这才是用户第二次投诉的落点（「改的锤子啊，好好看看下拉框颜色
  //    看什么颜色 背景色 字体颜色」）。上面的箭头几条钉的是"看得见的那一小块"，
  //    这几条钉的是"整块控件看起来是不是一个控件"。
  //
  //    容器 `.wb-chip.ghost.chip-ctl` 必须各自给出**可见的底与边**：
  //      · 底不能是 `transparent` —— 改前它透明，于是底 = 卡片底 --bg-panel，
  //        两枚下拉与卡片背景逐像素同色，用户读成"两段小灰字"；
  //      · 底也不能是 `var(--bg-panel)` —— 那与卡片**同色**，视觉效果与透明等同。
  //        这是本条断言的核心：**必须是两者之外的一档**（实际取 --bg-subtle）。
  //      · 字色不能是 `var(--text-dim)` —— 那一档比正文淡，12.5px 上读不清"我选的是
  //        哪个模型"。改后取 --text。
  //    ⚠️ 为什么用**正则抓 var(...) 名字**而不是断言具体色值：具体色值会随主题走，
  //       钉死 #f1f3f5 这种字面量等于把主题令牌废掉（也会写上第二个真相源）。
  //       这里钉的是"**引用的是哪一档令牌**" —— 跟 `.wb-chip.ghost` 那条基线同一个思路。
  //    ⚠️ 抓 `color` 必须写成 `(?:^|[\s;])color:`，不能只写裸的 `color:` ——
  //       `border-color` 里也含 `color`，裸写会把 `--border` 抓成"字色"，
  //       于是断言测的是一个**不存在的缺陷**（这条我自己踩过一次，是被校验脚本逮出来的）。
  const decl = (re) => (re.exec(ctlRule) || [])[1] || '';
  const ctlBg = decl(/(?:^|[\s;])background:\s*([^;]+)/);
  assert.ok(ctlBg, '`.wb-chip.ghost.chip-ctl` 要给一个 background —— '
    + '改前它靠 .wb-chip 基类的 var(--bg-panel) 落到卡片同色，读起来不像控件: ' + ctlRule);
  assert.ok(!/^\s*transparent\s*$/.test(ctlBg),
    '`.chip-ctl` 的底不许是 transparent（它被 .wb-chip.ghost 那层透明盖着，'
    + '视觉上等于"没有底"，这正是用户说的"背景色有问题"）: ' + ctlBg);
  assert.ok(!/var\(--bg-panel\)/.test(ctlBg),
    '`.chip-ctl` 的底不许用 --bg-panel —— 那是卡片自己的底色，与卡片**逐像素同色**，'
    + '等于没给底。要取与卡片底**不同**的一档（写的是 --bg-subtle）: ' + ctlBg);

  const ctlColor = decl(/(?:^|[\s;])color:\s*([^;]+)/);
  assert.ok(ctlColor, '`.wb-chip.ghost.chip-ctl` 要给出字色（否则继承 .wb-chip.ghost 的 --text-dim）: ' + ctlRule);
  assert.ok(!/var\(--text-(dim|faint)\)/.test(ctlColor),
    '字色不许是 --text-dim / --text-faint —— 它是**控件的当前值**（我选的是哪个模型），'
    + '必须一眼读清，比正文淡一档就是读不清的成因: ' + ctlColor);
  assert.ok(/var\(--text\)/.test(ctlColor),
    '字色取 --text（与附件钮 hover 后的色阶同档）: ' + ctlColor);

  // select 自己保持"透明 + 继承"：底与字色由容器**一处**定义，避免两个真相源。
  // （改前它是 `background: transparent; color: inherit` —— 这一半本来就对，
  //   错的是容器那层把 inherit 的源头设成了透明 + --text-dim。）
  assert.ok(/color:\s*inherit/.test(selRule),
    'select 的 color 要保持 inherit（由容器给，别在这里再写一份）: ' + selRule);
  assert.ok(/background:\s*transparent/.test(selRule),
    'select 的 background 保持 transparent（底色画在容器上）: ' + selRule);
});

/* ── 0.21.7：左栏展开入口 / 节头显隐 / 正文与输入卡同列 / 目录选择器 ───────── */

await t('0.21.7/0.21.8 左栏收起：入口不能住在被隐藏的那一栏里；收起态要立起一列入口（展开 / 后台 / 设置 / 账号）', async () => {
  const { dom, sandbox, calls } = await openWorkbench();
  assert.ok(!/wb-side-expand/.test(dom.state.html), '左栏展开时不该有「展开左栏」钮');
  assert.ok(!/wb-siderail/.test(dom.state.html), '左栏展开时不该有竖排入口栏');

  sandbox.window.App.wbToggleSide();
  await settle(calls);
  const html = dom.state.html;
  assert.ok(/class="wb rail-closed side-closed"|class="wb side-closed"/.test(html), '应进入收起态');
  assert.ok(/wb-side-expand/.test(html), '收起后必须出现「展开左栏」钮');
  assert.ok(/title="展开左栏"/.test(html), '钮的 title 要说清它是干什么的');

  // ★ 这条用例真正要钉的不是"有按钮"，而是**按钮不在栏里**。
  //   机理：`.wb.side-closed .wb-side { display:none }` 会把整栏藏掉 —— 收起钮住在栏内，
  //   于是它跟着一起消失，界面上再也没有可达的展开入口（用户报的"收起后无法展开"）。
  //   修法是把展开入口渲染在 `.wb-side` **之外**（0.21.8 起是一个 `<nav>`，见下）。
  const aside = (html.match(/<aside class="wb-side">[\s\S]*?<\/aside>/) || [''])[0];
  assert.ok(aside, '左栏容器应仍在 DOM 里（display:none 的元素仍在 DOM）');
  assert.ok(!/wb-side-expand/.test(aside),
    '展开钮**不能**住在 .wb-side 里 —— 那正是它跟着一起被藏掉、于是点不到的原因');
  assert.ok(/wb-side-expand/.test(html.replace(aside, '')), '它必须被渲染在 .wb-side 之外');
  assert.ok((html.match(/data-act="wbToggleSide"/g) || []).length >= 2,
    '收起 / 展开两颗钮都要在标记里：它们调**同一个**动作，只是出现条件相反（一个状态两个方向）');

  // ★ 0.21.8：收起态左侧立着的是**一列入口**，不是一颗孤钮。
  //   用户给的四项必须都在，而且每一项都得指向真实路由 —— 图标没有文字，是靠 title 说话的。
  const rail = (html.match(/<nav class="wb-siderail"[\s\S]*?<\/nav>/) || [''])[0];
  assert.ok(rail, '收起后应渲染竖排入口栏 .wb-siderail');
  assert.ok(/aria-label=/.test(rail), '入口栏要有 aria-label —— 一组纯图标按钮，读屏器靠组名分辨它是什么');
  assert.equal((rail.match(/wb-iconbtn/g) || []).length, 4,
    '入口栏里恰好四项：展开左栏 / 管理后台 / 设置 / 我的账号（多了少了都说明清单漂了）');
  assert.ok(/class="wb-iconbtn wb-side-expand"/.test(rail),
    '第一项是「展开左栏」（占据原来收起钮的位置，一进一出同一处）');
  for (const [hash, title] of [['#/overview', '管理后台'], ['#/settings', '设置'], ['#/me', '我的账号']]) {
    assert.ok(rail.includes('data-nav="' + hash + '"'),
      '收起态入口栏少了「' + title + '」—— 这三项原来住在左栏底部，收起时跟着整栏一起消失了');
    assert.ok(rail.includes('title="' + title),
      '「' + title + '」必须带 title：图标没有文字，悬停提示与读屏器都只靠它');
  }

  // 位置：展开入口在**顶**、三个导航项在**底**。
  // 这不是审美 —— 底三项与展开态里 `.wb-side-foot`（同样在左栏最下面）一一对应，
  // 切换开合时同一个入口落在同一处，视线不用重新找。
  const railFoot = (rail.match(/<div class="wb-siderail-foot">[\s\S]*?<\/div>/) || [''])[0];
  assert.ok(railFoot, '三个导航项应包在 .wb-siderail-foot 里（否则它们会紧挨着展开钮挤在顶端）');
  for (const hash of ['#/overview', '#/settings', '#/me']) {
    assert.ok(railFoot.includes('data-nav="' + hash + '"'), '「' + hash + '」应在栏底那一段里');
  }
  assert.ok(!/data-nav=/.test(rail.replace(railFoot, '')),
    '栏顶只该有「展开左栏」一颗 —— 导航项跑到上面去，就不是"顶上展开、底下入口"了');
  assert.ok(/\.wb-siderail-foot\s*\{[^}]*margin-top:\s*auto/.test(WB_CSS()),
    '.wb-siderail-foot 必须 margin-top:auto 才贴得到栏底（少了它，三项会挨着展开钮挤在顶上）');

  // 设置图标：必须是**齿占掉周长一大半**的真齿轮，不能是 ☀（太阳）。
  // 0.21.9：判据升级。此前判"两个圆"（轮体 + 轴心孔），结果第二版（细环 + 6 根径向短线
  // + 轴心孔）照样过了断言、用户看一眼仍是太阳 —— 教训：**线状齿再密也不是齿**，
  // 真齿轮与太阳的分界是"齿是面、且占掉周长一大半"。所以现在钉的是**齿廓闭合路径**：
  // `d` 里必须有一条以 `Z` 收尾的多边形（齿顶 + 齿根环的剪影），轴心孔只是配角。
  const gearSvg = (rail.match(/title="设置">[\s\S]*?<\/svg>/) || [''])[0];
  assert.ok(gearSvg, '收起态入口栏里应能找到「设置」那一项的图标');
  const gearPath = (gearSvg.match(/<path[^>]*d="([^"]*)"/) || [])[1] || '';
  assert.ok(/Z\s*$/.test(gearPath) && (gearPath.match(/L/g) || []).length >= 20,
    '设置图标必须有一条闭合齿廓多边形（>=20 段直线的 Z 收尾路径）—— 细环配径向短线会被读成太阳：'
    + gearSvg.slice(0, 120));
  assert.ok((gearSvg.match(/<circle/g) || []).length === 1,
    '轴心孔恰好一个圆：没有它是实心饼，多一个是表盘刻度：' + gearSvg.slice(0, 120));

  // ★ 定位判据随实现变了 —— 改断言，而不是删断言。
  //   0.21.7 的展开钮是**悬浮在主区左上角的一颗孤钮**（绝对定位）；0.21.8 起它搬进了入口栏，
  //   整栏是网格里**真实的一列**。要钉的不变式因此换成"这一列确实占了网格的一格"：
  //   悬浮版在窄视口下必然压住正文列左缘，而且"到底有没有盖住内容"只能靠量。
  assert.ok(!/\.wb-side-expand\s*\{[^}]*position:\s*absolute/.test(WB_CSS()),
    '.wb-side-expand 不该再绝对定位 —— 它现在是入口栏里普通的一项（旧的悬浮写法应已删除）');
  assert.ok(/\.wb\.side-closed\s*\{[^}]*grid-template-columns:\s*56px/.test(WB_CSS()),
    '收起态网格必须给入口栏留出固定的一列 —— 这是"它是栏、不是浮层"的全部依据'
    + '（0.21.9 起列宽 56px，44px 时图标几乎贴边框）');
  assert.ok(/\.wb-siderail\s*\{[^}]*border-right/.test(WB_CSS()),
    '.wb-siderail 要有自己的右边框：它是一列，得和主区划出边界');

  sandbox.window.App.wbToggleSide();
  await settle(calls);
  assert.ok(!/side-closed/.test(dom.state.html), '再点一次应展开');
  assert.ok(!/wb-side-expand/.test(dom.state.html), '展开后「展开左栏」钮应消失（避免两个入口同时在场）');
});

/* ── 右栏「上下文面板」默认展开（0.21.9，用户 2026-10-08）──────────────────
 *
 * 用户原话：「右侧栏 上下文面板 默认显示」。
 *
 * 它从前是**默认收起**的（0.21.2 起，理由是"与原生 Harness 第一屏一致"）。
 * 翻过来的理由是那一栏装的是**当前会话的事实**（用量 / 产物）—— 而"这个会话
 * 跑掉了多少 token、产出了什么"正是用户一进来就想知道的。默认收起等于把这条
 * 事实藏在一颗**纯图标钮**后面：钮上没有文字，不知道要点它的人永远不会点，
 * 那一栏就等于不存在。收起的默认值只对"内容多到碍事"的面板才成立。
 *
 * ⚠️ 这个默认值是**唯一真相源**（`State.wb.railOpen` 的初值），本用例直接钉它，
 *    不去钉"渲染出来长什么样"—— 后者由 test-browser 的真机用例管（列轨 / 折行 /
 *    点开收起双向生效）。两条用例分工不同，别互相代替。
 *
 * ⚠️ 顺带钉住"**没做持久化**"这件事：刷新后必须回到默认值。
 *    这也正是"默认值可以改"的前提 —— 默认一旦能被旧偏好覆盖，这份判断就再也改不动。
 */
await t('右栏上下文面板默认展开，且开合状态不落盘（刷新回到默认）', async () => {
  const { dom, sandbox, calls } = await openWorkbench();
  // ① 首屏就该是展开的：`.wb` 根节点不带 `rail-closed`，且 `#wb-rail` 在 DOM 里。
  assert.ok(!/rail-closed/.test(dom.state.html),
    '右栏默认要**展开**（根节点不该带 rail-closed）—— 用户原话：「右侧栏 上下文面板 默认显示」');
  assert.ok(/id="wb-rail"/.test(dom.state.html),
    '默认展开时右栏面板本体要在 DOM 里（不带开合钮时它是按 railOpen 条件渲染的）');

  // ② 开合钮仍要在，且是可读的（图标钮只能靠 title 表意）。
  assert.ok(/data-act="wbToggleRail"/.test(dom.state.html), '开合钮不能因为默认展开就消失');
  assert.ok(/title="上下文面板/.test(dom.state.html),
    '开合钮的 title 里要有「上下文面板」—— 它是这颗纯图标钮唯一的可读标签');

  // ③ 点一下就收起（默认值不影响双向开合）。
  sandbox.window.App.wbToggleRail();
  await settle(calls);
  assert.ok(/rail-closed/.test(dom.state.html), '点一下应收起');
  assert.ok(!/id="wb-rail"/.test(dom.state.html), '收起后右栏本体应离开 DOM');

  // ④ 再点回来。
  sandbox.window.App.wbToggleRail();
  await settle(calls);
  assert.ok(!/rail-closed/.test(dom.state.html), '再点一下应展开（不是单向开关）');

  // ⑤ **不落盘**：把状态改成收起，重新装配一次工作台，应回到默认（= 展开）。
  //    这条是防"将来有人顺手加个 localStorage 记住开合"—— 那会让本用例①的默认值失效，
  //    而失效的方式很隐蔽（本机点过一次之后，任何断言都测不出"默认"是什么了）。
  sandbox.window.App.wbToggleRail();
  await settle(calls);
  assert.ok(/rail-closed/.test(dom.state.html), '前置：此时是收起态');
  runInApp(sandbox, `State.wb.railOpen = true; render();`);   // 模拟"重新装配回默认值"
  const after = dom2html(sandbox);
  assert.ok(!/rail-closed/.test(after),
    '回到默认值后应是展开 —— 开合状态不许被持久化成偏好（否则默认值再也改不动）');
});

await t('0.21.7 工作区节头：过滤与新建常驻 DOM、划过节头才现身，「重新拉取」入口已删', async () => {
  const { dom } = await openWorkbench();
  const html = dom.state.html;
  // 取节头那一段（从 .wb-sec-head 到树的起点）—— 用 indexOf 切片比正则可靠：
  // 节头里嵌了两层 span，靠正则配嵌套括号很容易配歪，而配歪之后断言会静默变绿。
  const hAt = html.indexOf('wb-sec-head');
  const tAt = html.indexOf('wb-tree');
  const head = hAt >= 0 && tAt > hAt ? html.slice(hAt, tAt) : '';
  assert.ok(head, '工作区节头要渲染');
  // 两个动作**恒在 DOM 里**（显隐交给 CSS 的 hover，不是条件渲染）——
  // 这一点必须钉住：真机层只能靠 hover 让它们现身，DOM 里没有就等于功能没做。
  assert.ok(/data-act="wbToggleTreeFilter"/.test(head), '过滤钮要常驻 DOM（不在 DOM 里就没法被 hover 出来）');
  assert.ok(/data-act="wbNewWorkspace"/.test(head), '新建工作区钮要常驻 DOM');
  assert.ok(/class="wb-sec-tools"/.test(head), '两个动作要包在 .wb-sec-tools 里（hover 显隐的容器）');
  // 「重新拉取工作区与会话列表」**整块删除**（用户裁定）：树在切会话、建/删/改之后都会自己重拉，
  // 手动刷新是个多余且容易误判的入口。反向断言 —— 防"删了按钮忘了删动作/样式"。
  assert.ok(!/data-act="wbEnsureLoaded"/.test(html), '「重新拉取」这个入口不该再出现在任何地方');

  // ⚠️ "划过才出现"必须是 opacity，**不能**是 display:none / visibility:hidden ——
  //    后两者会让按钮从 **Tab 序列里消失**，键盘用户就再也够不到"新建工作区"。
  //    这条只能读样式表验（vm 垫片里没有真实布局与焦点）。
  const css = WB_CSS();
  const toolsCss = [...css.matchAll(/\.wb-sec-tools\s*\{([^}]*)\}/g)].map((m) => m[1]).join(';');
  assert.ok(/opacity:\s*0/.test(toolsCss), '.wb-sec-tools 默认要用 opacity:0 隐形');
  assert.ok(!/display:\s*none/.test(toolsCss) && !/visibility:\s*hidden/.test(toolsCss),
    '.wb-sec-tools 不许用 display:none / visibility:hidden（那会让键盘聚焦不到它）');
  assert.ok(/\.wb-sec-head:focus-within\s+\.wb-sec-tools[^{]*\{[^}]*opacity:\s*1/.test(css),
    '要有一条 :focus-within 规则 —— Tab 进来立刻显形，纯键盘操作不能摸黑找');
  assert.ok(/\.wb-sec-head:hover\s+\.wb-sec-tools[^{]*\{[^}]*opacity:\s*1/.test(css),
    '还要有 hover 显形那条（用户说的"鼠标划过显示"）');

  // ★ 0.21.9：这一行的**醒目度**一起钉住。用户为这一行提过两次
  //   （0.21.7"鼠标划过显示"→ 0.21.9"突出一下，不醒目"），说明它很容易在后续改样式时被改回"看不见"。
  //   两条判据：
  //     · 标题不许退回最淡的那一档 —— `--text-faint` 是给**元信息**用的（会话行的时间、路径），
  //       节标签用它就淹在树里了；也不能给 `--text`（那是内容色，节标签比内容还深就反了）；
  //     · 两个动作要有**常驻的底**：划过现身的那一刻用的就是静息样式，
  //       从前那一刻是"两枚飘着的淡图标"，所以用户会说"不醒目"。
  const titleCss = [...css.matchAll(/\.wb-sec-title\s*\{([^}]*)\}/g)].map((m) => m[1]).join(';');
  assert.ok(/color:\s*var\(--text-dim\)/.test(titleCss),
    '.wb-sec-title 要用 --text-dim（--text-faint 会把这一行淹掉）：' + titleCss);
  assert.ok(/font-weight:\s*600/.test(titleCss), '节标签要加字重才立得住：' + titleCss);
  const secBtnCss = [...css.matchAll(/\.wb-sec-tools\s+\.wb-iconbtn\s*\{([^}]*)\}/g)].map((m) => m[1]).join(';');
  assert.ok(/background:\s*var\(--bg-panel\)/.test(secBtnCss),
    '节头两颗钮要有常驻的底，划过现身时才读得出是"按钮"：' + secBtnCss);
  // 反向：醒目度**只加在节头这一处**。`.wb-iconbtn` 是节头 / 主区右上 / 卡内 ＋ 三处共用的，
  // 改基类会把"只调工作区那一行"变成"全站图标钮都变重"。
  // ⚠️ 先剥注释：样式表里 `.wb-iconbtn` 前面正好是一段注释，不剥的话"规则开头"的定位会配不上，
  //    而那会**静默**变成"这条断言没测到东西"（`baseBtnCss` 为空 → 断言失败，还算幸运；
  //    若写成"不许出现 X"就成了假绿）。
  const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const baseBtnCss = [...cssBare.matchAll(/(?:^|\})\s*\.wb-iconbtn\s*\{([^}]*)\}/g)].map((m) => m[1]).join(';');
  assert.ok(baseBtnCss, '要能定位到 .wb-iconbtn 的基类规则（定位不到 = 这条断言没在测东西）');
  assert.ok(/background:\s*transparent/.test(baseBtnCss),
    '.wb-iconbtn 基类要保持透明 —— 加重的样式只写在 .wb-sec-tools 作用域里：' + baseBtnCss);
});

await t('0.21.10 左侧栏：品牌字标更醒目、条目悬停跨主题都看得见、输入框占位文案不再"大蓝字"', async () => {
  const css = WB_CSS();
  const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => [...cssBare.matchAll(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g'))]
    .map((m) => m[1]).join(';');

  // ── ① 品牌字标（用户提了两轮：0.21.9"再醒目一点"，0.21.10"再醒目一点"）──
  //   钉的是**三样同时成立**，因为只靠字号拉不开层级（17px 在 13px 的侧栏里已经试过，用户说还不够）：
  //     · 字号与后台 .brand 对齐（同一个产品名不该在两个界面里是两个大小）；
  //     · 左侧有一根 accent 竖条（**与字号无关**的可见度增益）；
  //     · 后半截走 accent 而不是 text-faint（拿"禁用色"当字标 = 主动降低存在感，0.21.9 已修，这里防回退）。
  const logoCss = rule('.wb-logo');
  assert.ok(logoCss, '要能定位 .wb-logo（定位不到 = 这条断言没在测东西）');
  const logoSize = parseFloat((/font-size:\s*([\d.]+)px/.exec(logoCss) || [])[1] || '0');
  assert.ok(logoSize >= 19, '字标字号至少 19px（与 .brand 对齐），实际 ' + logoSize);
  const brandCss = rule('.brand');
  const brandSize = parseFloat((/font-size:\s*([\d.]+)px/.exec(brandCss) || [])[1] || '0');
  assert.ok(logoSize === brandSize,
    '工作台字标与后台 .brand 要同字号（同一产品名两个大小）：logo ' + logoSize + ' vs brand ' + brandSize);
  assert.ok(/border-left:\s*3px\s+solid\s+var\(--accent\)/.test(logoCss),
    '字标左侧要有 accent 竖条（结构性强调，不依赖字号）：' + logoCss);
  assert.ok(/padding-left:\s*[\d.]+px/.test(logoCss),
    '竖条要占在 padding-left 里，不许撑宽 .wb-brand（会压窄左栏树的可视区）：' + logoCss);
  const logoBCss = rule('.wb-logo b');
  assert.ok(/color:\s*var\(--accent\)/.test(logoBCss),
    'HARNESS 后半截要走 accent（不许退回 --text-faint）：' + logoBCss);

  // ── ② 悬停：**跨主题都要看得见** ─────────────────────────────────
  //   真因：`--bg-panel` 在暗色里比侧栏底（--bg-subtle）**更暗**，
  //   拿它当悬停底 = 划过几乎没变化。所以钉的是"用专用悬停色 + 两套主题都定义"。
  for (const sel of ['.wb-sideitem:hover', '.wb-account-id:hover', '.wb-session:hover', '.wb-ws-row:hover']) {
    const c = rule(sel);
    assert.ok(c, '要能定位 ' + sel + '（定位不到 = 这条断言没在测东西）');
    assert.ok(/background:\s*var\(--bg-hover\)/.test(c),
      sel + ' 的悬停底必须用 --bg-hover（用 --bg-panel 在暗色下等于没反馈）：' + c);
    assert.ok(!/background:\s*var\(--bg-panel\)/.test(c),
      sel + ' 不许退回 --bg-panel —— 那正是"暗色下看不见"的原因');
  }
  // --bg-hover 必须在**两套主题**里都有值，且与侧栏底有**足够的亮度差**
  const hex2rgb = (h) => { const m = /^#([0-9a-f]{6})$/i.exec(h); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
  const lum = (h) => { const c = hex2rgb(h); return c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) : null; };
  const themeBlock = (name) => {
    const m = new RegExp(':root\\[data-theme="' + name + '"\\]\\s*\\{([\\s\\S]*?)\\}').exec(cssBare);
    return m ? m[1] : '';
  };
  for (const th of ['light', 'dark']) {
    const blk = themeBlock(th);
    assert.ok(blk, '要能定位 ' + th + ' 主题变量块');
    const hv = (/--bg-hover:\s*(#[0-9a-f]{6})/i.exec(blk) || [])[1];
    const sub = (/--bg-subtle:\s*(#[0-9a-f]{6})/i.exec(blk) || [])[1];
    assert.ok(hv && sub, th + ' 主题里 --bg-hover 与 --bg-subtle 都要有值（实际 hover=' + hv + ' subtle=' + sub + '）');
    // ★ 本用例的核心断言：侧栏坐在 --bg-subtle 上，悬停色必须与它拉开足够亮度差。
    //   ⚠️ 判据是**差值的绝对值**，不是"更亮" —— 方向在两套主题里相反：
    //     亮色主题的高亮 = 压暗（白底上加深灰），暗色主题的高亮 = 提亮。
    //   ⚠️ 这条断言的第一版**写错过**：它写成 `lum(hv) > lum(sub)`，于是把亮色主题
    //     正确地报成了失败（#e8ebef 比 #f1f3f5 暗）。那是断言错了，不是值错了 ——
    //     值当时是对的，我却差点反着去改值。教训：**先想清楚不变量的方向**再写断言，
    //     否则会把"断言不理解真实语义"误读成"代码有 bug"。
    //   阈值 8：两色亮度差小于这个数在实测里几乎看不出来（--bg-panel 与 --bg-subtle
    //   在暗色下只差 ~4，正是"划过看不出来"的根源）。
    const d = Math.abs(lum(hv) - lum(sub));
    assert.ok(d >= 8,
      th + ' 主题：--bg-hover 与 --bg-subtle 的亮度差要 >= 8（悬停才看得见），实际 '
      + hv + '(lum ' + lum(hv).toFixed(1) + ') vs ' + sub + '(lum ' + lum(sub).toFixed(1) + ') 差 ' + d.toFixed(1));
    // 反向：悬停色**不许等于** --bg-panel（那就是本次修掉的旧写法）
    const panel = (/--bg-panel:\s*(#[0-9a-f]{6})/i.exec(blk) || [])[1];
    assert.ok(hv.toLowerCase() !== String(panel).toLowerCase(),
      th + ' 主题里 --bg-hover 不该与 --bg-panel 同值（分开才有意义）');
  }
  // 条目悬停还要有**结构性**提示（边框）：极低对比度下轮廓比底色差更好抓
  assert.ok(/border:\s*1px\s+solid\s+transparent/.test(rule('.wb-sideitem')),
    '.wb-sideitem 基础态要有 1px 透明边框占位（悬停时才不出跳一下）：' + rule('.wb-sideitem'));
  assert.ok(/border-color:\s*var\(--border-strong\)/.test(rule('.wb-sideitem:hover')),
    '.wb-sideitem:hover 要把边框点亮（不只是换底色）：' + rule('.wb-sideitem:hover'));

  // ── ③ 输入框占位文案：不再"大蓝字" ────────────────────────────
  //   `::placeholder` **不继承** textarea 的 font-size/color，各引擎按 UA 默认渲染
  //   （Chrome 那套偏蓝、字号也不跟）—— 所以必须**显式**声明，且要覆盖各引擎前缀写法。
  assert.ok(/\.wb-card textarea::placeholder\s*\{[^}]*color:\s*var\(--text-faint\)/.test(css),
    '占位文案要显式声明颜色（不声明就会落回浏览器的偏蓝 UA 默认）');
  assert.ok(/\.wb-card textarea::placeholder\s*\{[^}]*font-size:\s*[\d.]+px/.test(css),
    '占位文案要显式声明字号（::placeholder 不继承 textarea 的 font-size）');
  for (const pfx of ['::-webkit-input-placeholder', '::-moz-placeholder', ':-ms-input-placeholder']) {
    assert.ok(css.includes('.wb-card textarea' + pfx),
      '要覆盖 ' + pfx + ' —— 少写一个就会出现"只在某个浏览器里又变回大蓝字"');
  }
  // 字号要与 textarea 正文一致，否则"提示语"和"打进去的字"长得不一样
  const taCss = rule('.wb-card textarea');
  const taSize = (/font-size:\s*([\d.]+)px/.exec(taCss) || [])[1];
  const phSize = (/\.wb-card textarea::placeholder\s*\{[^}]*font-size:\s*([\d.]+)px/.exec(css) || [])[1];
  assert.equal(phSize, taSize, '占位字号要与 textarea 正文字号一致（' + phSize + ' vs ' + taSize + '）');
});

await t('0.21.7 对话正文与输入卡同宽同列；宽度公式逐字同源', async () => {
  const { dom } = await openWorkbench();
  const html = dom.state.html;
  const sAt = html.indexOf('id="wb-stream"');
  const iAt = html.indexOf('wb-stream-inner');
  const mAt = html.indexOf('wb-msg');
  assert.ok(sAt >= 0 && iAt > sAt, '有内容时消息流内要套一层 .wb-stream-inner');
  assert.ok(mAt > iAt, '消息要在内层容器**里面** —— 那一层就是用来收窄正文的');

  // 同宽同列靠的是**同一个变量**：正文内层与输入卡都用 `--wb-compose-w`。
  // 各写各的宽度就是这次要修的病（此前正文横跨整个主区、输入卡居中收在 780px，
  // 一眼看去上下两截不在一条轴上）。
  //
  // ⚠️ 0.21.9 改口径：断言从"取 var(--wb-compose-w)"改成"**统一用 min(上限, 可用宽度)**"。
  //    原因是用户又报了第二个宽度症状（"提交对话的一瞬间很快变宽，然后又恢复正常"），
  //    而两次的病根是同一个：同一件事有**几份长得不一样的公式**。
  //    光钉"用了同一个变量"不够 —— `.wb-view-tabs` 当时也用了那个变量，
  //    但它是 `width + max-width` 形态，与 `min(...)` 形态**不是同一条公式**。
  //    所以现在钉的是**形态**，四处（正文内层 / 输入卡 / 页签条 / 提示与附件条）都要同源。
  const css = WB_CSS();
  const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里也写了这些公式，必须先剥掉
  const formulaOf = (sel) => {
    const m = new RegExp('(?:^|\\})\\s*' + sel + '\\s*\\{([^}]*)\\}').exec(cssBare);
    return m ? /width:\s*([^;]+);/.exec(m[1]) : null;
  };
  const want = 'min(var(--wb-compose-w, 1200px), calc(100% - 48px))';
  const need = [];
  for (const sel of ['\\.wb-compose-wrap', '\\.wb-view-tabs', '\\.wb-notice']) {
    const got = formulaOf(sel);
    assert.ok(got, '要能定位到 ' + sel + ' 的 width（定位不到 = 这条断言没在测东西）');
    assert.equal(got[1].replace(/\s+/g, ' ').trim(), want,
      sel + ' 必须以**同一条公式**写宽度，实际：' + JSON.stringify(got[1].trim()));
    need.push(sel);
  }
  assert.equal(need.length, 3, '这三处同源：输入卡 / 页签条 / 提示条');
  // ⚠️ `.wb-stream-inner` 是**唯一合法的不一样**，而且必须一直不一样：
  //    它的父级 `.wb-stream` 自带 `padding: 0 24px`，所以它的 `100%`
  //    **已经等于**"主区宽 - 48px"；再写一次 `calc(100% - 48px)` 就是**多扣一次**，
  //    那正是用户先报"上下两截差 48px"、后报"提交时闪一下"的同一个算术。
  //    所以这里钉的不是"四处逐字相同"，而是"**三处相同 + 这一处按自己的基准写**"：
  //    只要 `.wb-stream` 的内边距是 24px、`.wb-stream-inner` 取 `100%`，两者就同宽。
  const inner = formulaOf('\\.wb-stream-inner');
  assert.ok(inner, '要能定位到 .wb-stream-inner 的 width');
  assert.equal(inner[1].replace(/\s+/g, ' ').trim(),
    'min(var(--wb-compose-w, 1200px), 100%)',
    '.wb-stream-inner 的可用宽度要取 100%（它的父级已经扣过 48px 内边距），实际：'
    + JSON.stringify(inner[1].trim()));
  const streamPad = /\.wb-stream\s*\{([^}]*)\}/.exec(cssBare);
  assert.ok(streamPad && /padding:\s*52px\s+24px\s+12px/.test(streamPad[1]),
    '.wb-stream 的左右内边距必须是 24px —— `.wb-stream-inner` 的 `100%` 与其它三处的 '
    + '`calc(100% - 48px)` 能算出同一个数，**全靠这个 24px**：'
    + (streamPad ? streamPad[1] : '(定位不到 .wb-stream 规则)'));
  // 这个变量必须是**纯长度**：写成 calc(100% - …) 会在不同父元素上解析出不同的值
  //（正文内层的父元素带 24px 内边距、输入卡的不带），于是"同宽"在同一次渲染里就不成立。
  const v = /\.wb-main\s*\{\s*--wb-compose-w:\s*([^;]+);/.exec(cssBare);
  assert.ok(v, '找不到 --wb-compose-w 的定义');
  assert.ok(/^\d+px$/.test(v[1].trim()),
    '--wb-compose-w 应是一个纯长度（当前 ' + JSON.stringify(v[1].trim()) + '）—— 用 calc(100% - …) 会让两处解析出不同的值');
  // 而且要比原来的 780px 宽：用户的原话是"下面的对话框是不是太窄啦"
  assert.ok(parseInt(v[1], 10) > 780, '--wb-compose-w 应比原来的 780px 宽，实际 ' + v[1].trim());

  // 0.21.9 空态口径**反转**：`.wb-stream` 现在**恒有内容**。
  // ⚠️ 这条断言从前写的是"空态下 .wb-stream 里不该有任何子节点" —— 那依赖
  //    `.wb-main.is-empty .wb-stream:empty{display:none}` 让空流不占位，
  //    而**空态分支已整体删除**（用户：「搞成一套，不再搞什么会话前的样式」）。
  //    现在没有会话时，消息流里是 `wbStreamHtml` 写的一句"开始一段对话" ——
  //    它是**内容**，不是另一套布局。所以这里反过来钉：那句提示在、且在里层容器里。
  const { dom: empty } = await openWorkbench({
    overrides: wbOverrides({
      ['GET /api/kernel/sessions']: { status: 200, body: { items: [], total: 0 } },
    }),
  });
  assert.ok(/wb-stream-inner[\s\S]*?开始一段对话/.test(empty.state.html),
    '没有会话时消息流里也要有那句提示（且要在 .wb-stream-inner 里面）—— '
    + '空白会被读成"没加载出来"：' + (empty.state.html.match(/<div class="wb-stream"[\s\S]{0,200}/) || [''])[0]);
});

/** 目录列举桩：按 `?path=` 真的给不同内容（不是"问什么都回同一棵假树"）。 */
function wbBrowseStub(store) {
  return {
    status: 200,
    onCall(o, url) {
      const m = /[?&]path=([^&]*)/.exec(String(url));
      store.path = m ? decodeURIComponent(m[1]) : '';
    },
    get body() {
      const cur = store.path || 'C:\\demo';
      return {
        path: cur,
        // 到了根就如实给 null —— 前端不该摆一个点了没反应的「上一级」
        parent: cur === 'C:\\demo' ? 'C:\\' : 'C:\\demo',
        sep: '\\',
        entries: cur === 'C:\\demo' ? [{ name: 'proj-a', path: 'C:\\demo\\proj-a' }] : [],
        truncated: false,
        roots: [{ label: '默认工作区目录', path: 'C:\\demo' }],
      };
    },
  };
}

/**
 * 从 `from` 处的 `<div` 起数 div 深度，返回 `target` 所在层（**2 = 那个 div 的直接子级**）。
 * 用来断言"菜单渲染在行**里面**"—— 这是纯 CSS 定位问题（见对应的用例注释），
 * 只靠"菜单存在"或"在行后面"都断言不出来。
 *
 * ⚠️ 为什么是 2 而不是 1：本函数从 `from` 起数，而**第一个 `<div` 就是 `from` 自己那个**
 *    （`from` 由 `lastIndexOf('<div class="wb-ws-row')` 得到，指向行标签的开头）。
 *    所以容器自己算 1 层，它的直接子级是 2 层。
 *    判据对照（这也是它唯一要区分的两件事）：
 *      · 菜单是行的**直接子级**（正确）→ 行的 `<div` 记 1、菜单的 `<div` 记 2 → **2**；
 *      · 菜单是行的**兄弟**（坏掉的：行先 `</div>` 闭合、菜单再开）→ 行记 1、行闭合减到 0、
 *        菜单的 `<div` 再记 1 → **1**。
 *    所以"1 / 2"这两个值本身就是这对判据的两端，不能随手改。
 */
function divDepthAt(html, from, target) {
  let depth = 0;
  for (let i = from; i < target;) {
    const open = html.indexOf('<div', i);
    const close = html.indexOf('</div>', i);
    if (close >= 0 && (open < 0 || close < open)) { depth--; i = close + 6; continue; }
    if (open >= 0) { depth++; i = open + 4; continue; }
    break;
  }
  return depth;
}

await t('0.21.9 新建工作区就是一个**文件夹选择器**：只挑目录，「名称」不再问（取目录名）', async () => {
  // 这条动作改过四版，用户的原话按顺序是：
  //   ① 0.21.7「新建工作区弹框还是以前的输名称不是选择文件夹」；
  //   ② 0.21.9「新建工作区不要搞这么复杂，就搞成这种选择文件夹框就行啦」；
  //   ③ 0.21.9「新建工作区弹框不能做成 Windows 那种选择文件夹框样式吗」。
  // ② 点破了要害：这个框里**只有一样东西要用户决定** —— 哪个目录。名称是它的函数
  //（末段目录名），却一直被摆成一个必填输入框，于是整件事读起来还是"填表"。
  // ③ 补的是**形状**：光"没有输入框"不等于"像 Windows 那个框"。现在的骨架是
  //    上列表框 + 下 `文件夹(F): 路径` 结果行 + 右下两个按钮（见 15-dialog.js 的 browse 分支）。
  //
  // 为什么 cwd 必须由服务端列：它是**服务器上**的路径，手打有两个必然结局 —— 打错（不存在），
  // 或打对但不知道那是什么目录；浏览器也给不了服务器目录树（webkitdirectory 拿到的是客户端
  // 的目录，还只能得到 C:/fakepath/… 这种假路径）。
  const store = { path: '' };
  let sent = null;
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['GET /api/workspaces/browse']: wbBrowseStub(store),
      ['POST /api/workspaces']: {
        status: 201,
        onCall(o) { sent = o && o.body ? JSON.parse(o.body) : null; },
        body: { ok: true, workspace: { id: 'wsp_new', name: 'proj-a', cwd: 'C:\\demo\\proj-a' } },
      },
    }),
  });

  const p = sandbox.window.App.wbNewWorkspace();
  await settle(calls);                       // 打开即拉一次目录列表

  let dlg = dom.state.html;
  assert.ok(/modal-wrap dlg/.test(dlg), '点「新建工作区」要直接弹框');
  assert.ok(/class="dlg-path mono"/.test(dlg), '要有当前目录（只读展示，可整块复制）');
  assert.ok(/C:\\demo/.test(dlg), '路径取服务端 realpath 归一后的结果，而不是用户输入原样');
  assert.ok(/class="dlg-root"/.test(dlg), '要给常用起点（默认工作区目录等），省掉"从盘符点起"');
  // ── Windows 那个框的**形状**（第三版补的就是这个）────────────────────
  assert.ok(/modal dlg kind-browse/.test(dlg),
    '选择器要带 kind-browse —— 它决定"这个框更宽"。窄框里目录名会被省略号吃掉，'
    + '而用户正要在这个列表里挑出自己那一个目录');
  assert.ok(/class="dlg-pathrow"/.test(dlg) && /文件夹\(F\):/.test(dlg),
    '路径要以 Windows 那种 `文件夹(F):` 结果行的形式出现');
  const listAt = dlg.indexOf('class="dlg-list"');
  const rowAt = dlg.indexOf('class="dlg-pathrow"');
  assert.ok(listAt >= 0 && rowAt > listAt,
    '结果行必须在**列表之后** —— 路径是"你正指着哪个文件夹"这个结果，'
    + '摆在列表上面，整件事读起来又成了一张"第一格填路径"的表单');
  assert.ok(/data-act="dlgBrowseGo" data-a1="C:\\demo\\proj-a"/.test(dlg), '子目录要可点进去');
  // ★ 反向（0.21.9）：底部那个「不设工作目录」已按用户裁定删除 —— 这个框只剩"挑一个目录"。
  //   判据用**动作名**而不是文案：事件委托是 `App[data-act]`，留下这个名字就是一个死按钮。
  assert.ok(!/dlgBrowseSkip/.test(dlg), '不许再有「不设工作目录」这个出口（用户裁定去掉）');
  assert.ok(!/不设工作目录/.test(dlg), '那段文案也要一起删干净');

  // ★ 反向：**弹框里**不该有任何输入框。这是本版最重要的一条 ——
  //   "看起来像选择文件夹"和"真的是选择文件夹"的区别就在这一个元素上。
  //
  // ⚠️ 0.21.12 修正：判据必须**只看弹框那一段**。`dlg` 是整个页面的 HTML
  //    （`dom.state.html`），而工作台自己有一个**藏起来的附件选择器**
  //    （`<input type="file" id="wb-file" style="display:none">`，在输入卡里，
  //    与这个弹框无关）。拿整页去断言"没有 input"，等于要求工作台不许有附件入口 ——
  //    那会把一个正常元素判成本次改动的违规。切片起点取 `modal-wrap dlg`，
  //    终点取它自己的收尾（对话框是这段 HTML 的最后一块，见 15-dialog.js）。
  const dlgStart = dlg.indexOf('<div class="modal-wrap dlg">');
  assert.ok(dlgStart >= 0, '找不到对话框标记（`modal-wrap dlg`）');
  const dlgHtml = dlg.slice(dlgStart);
  assert.ok(!/<input/.test(dlgHtml),
    '选择器里不许有输入框（名称不再问；路径也只能点、不能打）：'
    + (dlgHtml.match(/<input[^>]*>/g) || []).join(' '));
  // 名称的**结果**要如实显示（不是输入框，是那行说明）—— 用户得能在按「创建」前知道它会叫什么
  assert.ok(/class="dlg-name-hint"/.test(dlg) && /工作区名称：<b>demo<\/b>/.test(dlg),
    '要显示"点这个目录会建出叫什么名字的工作区"：' + dlg.replace(/\s+/g, ' ').slice(0, 600));

  // 点进子目录 → 真的再问一次服务端（不是前端拼一棵假树），并且那行名称提示跟着变
  sandbox.window.App.dlgBrowseGo('C:\\demo\\proj-a');
  await settle(calls);
  assert.equal(store.path, 'C:\\demo\\proj-a', '拉的时候要把目标目录**带上去**（键会去 query，所以要另看）');
  dlg = dom.state.html;
  assert.ok(/C:\\demo\\proj-a/.test(dlg), '当前路径要跟着走到子目录');
  assert.ok(/dlg-item up/.test(dlg), '非根目录要给出「上一级」（到了根就不给，服务端给 null）');
  assert.ok(/工作区名称：<b>proj-a<\/b>/.test(dlg),
    '点进哪个目录，那行名称提示就换成哪个目录名 —— 只挑目录、直接点「创建」也能成');

  sandbox.window.App.dlgOk();
  await p;
  await settle(calls);
  assert.ok(sent, '要真的发出建工作区请求');
  assert.equal(sent.cwd, 'C:\\demo\\proj-a', 'cwd 应是选中的那个目录，实际：' + JSON.stringify(sent));
  // ★ 名称与那行提示必须是**同一个函数**（wbPathName）算的：提示说 proj-a 而建出来叫别的，
  //   比不显示那行还糟。这条断言就是那一对的「等式」。
  assert.equal(sent.name, 'proj-a', '名称取所选目录的末段名，且与提示里显示的**必须一致**');
});

await t('0.21.9 「不设工作目录」整块删除：界面上没有这个出口，App 上也没有这个动作', async () => {
  // 用户裁定原话：「新建工作区弹框，去掉最下面的不设置工作目录」。
  // 删除理由（写在 15-dialog.js 的 Dlg.browse 注释里）：这个框叫「新建**工作区**」，
  // 而"工作目录"是工作区**唯一有实质影响**的属性 —— 一个不绑任何目录的"工作区"说不清
  // 自己是什么；而它还让取值多出一个**只在建完之后才显形**的分支（空串 vs 路径）。
  // 服务端能力没减：`workspace.create` 照旧接受空 cwd（API 层一字未动），少的只是界面出口。
  const store = { path: '' };
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['GET /api/workspaces/browse']: wbBrowseStub(store),
      ['POST /api/workspaces']: {
        status: 201,
        body: { ok: true, workspace: { id: 'wsp_new', name: 'demo', cwd: 'C:\\demo' } },
      },
    }),
  });
  const p = sandbox.window.App.wbNewWorkspace();
  await settle(calls);
  const dlg = dom.state.html;
  // ★ 两条反向断言：一条钉界面（按钮与文案），一条钉**动作表**。
  //   后者才是真正的坑 —— 事件委托按 `App[data-act]` 取函数，只删 DOM 不删动作会留下
  //   "点了没反应"的死按钮，只删动作不删 DOM 也一样。两处必须一起走。
  assert.ok(!/dlg-skip/.test(dlg),
    '弹框里不许再有「不设工作目录」按钮：' + dlg.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(!/不设工作目录/.test(dlg), '那段文案也要删干净');
  assert.equal(typeof sandbox.window.App.dlgBrowseSkip, 'undefined',
    'App 上那颗动作也必须删 —— 留着它就是一个取不到函数的活按钮');
  sandbox.window.App.dlgCancel();
  await p;
});

await t('0.21.9 取消目录选择 = null：建工作区这条链整个不做（一个请求都不发）', async () => {
  // 取值删成两态之后，「取消」是**唯一**的否定态，判它只能用 `=== null`。
  // ⚠️ 这不是形式主义：在还留着「不设工作目录」的那一版里，写成 `if (!v)` 会把一个
  //    **有效选择**（空串）当成取消、静默什么都不做 —— 那正是"点了创建却什么都没发生"。
  const store = { path: '' };
  let sent = null;
  const { sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['GET /api/workspaces/browse']: wbBrowseStub(store),
      ['POST /api/workspaces']: {
        status: 201,
        onCall(o) { sent = o && o.body ? JSON.parse(o.body) : null; },
        body: { ok: true, workspace: { id: 'wsp_new', name: 'demo', cwd: 'C:\\demo' } },
      },
    }),
  });
  const p = sandbox.window.App.wbNewWorkspace();
  await settle(calls);
  const before = calls.length;
  sandbox.window.App.dlgCancel();                     // Dlg.close(null)
  await p;
  await settle(calls);
  assert.equal(sent, null, '取消之后不许发建工作区请求');
  assert.ok(!calls.slice(before).some((c) => c === 'POST /api/workspaces'),
    '取消＝建工作区这条链整个不做，实际：' + JSON.stringify(calls.slice(before)));
});

await t('0.21.9 目录没读出来时点「创建」：不关窗、如实报错（不许静默建出"没有工作目录"的工作区）', async () => {
  // 这是选择器**唯一**剩下的一道校验（名称那道随输入框一起没了，"不设工作目录"整块删了）：
  //   ① `browsePath` 为空时若照常关窗，返回的空串到了服务端会被当成"没给 cwd"——
  //      用户点的是「创建」，结果**静默**建出一个没有工作目录的工作区（界面什么也没说）。
  //      ⚠️ 0.21.9 删掉「不设工作目录」之后 `wbNewWorkspace` 还有第二道同向的拦阻，
  //         但**两道都要在**：这一道负责"不关窗、说清为什么"，那一道负责"万一漏了就绝不发请求"。
  //   ② 服务端给的真实失败原因（errno 之类）必须如实呈现，不能只说一句"失败了"。
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['GET /api/workspaces/browse']: {
        status: 400, body: { ok: false, error: { code: 'bad_request', message: '目录不可读：C:\\demo（EACCES）' } },
      },
      ['POST /api/workspaces']: { status: 201, body: { ok: true, workspace: { id: 'wsp_x', name: 'x', cwd: '' } } },
    }),
  });
  const p = sandbox.window.App.wbNewWorkspace();
  await settle(calls);

  sandbox.window.App.dlgOk();                           // 目录没读出来就点创建
  await settle(calls);
  const dlg = dom.state.html;
  assert.ok(/modal-wrap dlg/.test(dlg), '校验不过时**不许关窗**（关掉让人从头再来最气人）');
  assert.ok(/目录还没读出来/.test(dlg), '要说清"创建"为什么没生效：' + dlg.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(/读取目录失败/.test(dlg), '服务端给的真实原因也要如实呈现（EACCES 之类的 errno 要带上来）');
  assert.ok(!calls.some((c) => c === 'POST /api/workspaces'), '拦住时一个建工作区请求都不该发');

  sandbox.window.App.dlgCancel();
  await p;
});

await t('助手正文安全 markdown 子集：行内语法渲染、危险内容按字面显示', async () => {
  // 一条专门的帧序列把渲染器单独钉住：行内/围栏/链接/原始 HTML 四类输入一起喂，
  // 危险输入必须在输出里以**转义字面**存在（不允许出现可执行的 <script> / javascript: 链接）。
  const md = '**结论**：`备份要离线`。\n\n- 第一步\n- 第二步\n\n> 引用一句\n\n[好链](https://example.com) 与 [坏链](javascript:alert(1)) 与 <script>alert(2)</script>\n\n```js\nif (a && b) { run("<b>"); }\n```';
  const nd = [
    JSON.stringify({ kind: 'meta', sessionId: WB_SID }),
    JSON.stringify({ kind: 'turn', turnId: 'kt-md', accepted: true }),
    JSON.stringify({ kind: 'event', event: { seq: 1, type: 'turn-start', role: 'user', text: 'markdown 测试', known: true } }),
    JSON.stringify({ kind: 'event', event: { seq: 2, type: 'message', role: 'assistant', delta: md, known: true } }),
    JSON.stringify({ kind: 'event', event: { seq: 3, type: 'turn-end', role: 'assistant', text: 'done', known: true } }),
    JSON.stringify({ kind: 'done', eventsWritten: 3, lastSeq: 3, truncated: false,
      usageCollected: { written: 0, skipped: 0, totals: null }, artifactsRecorded: { written: 0, error: null },
      attachments: { requested: 0, sent: [], injected: [], skipped: [], missing: [] } }),
  ].join('\n') + '\n';
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({ ['POST /api/kernel/sessions/' + WB_SID + '/turns/stream']: { status: 200, text: nd } }),
  });
  dom.byId('wb-input').value = 'markdown 测试';
  await sandbox.window.App.wbSend();
  await settle(calls);
  const html = dom.state.html;

  assert.ok(/<strong>结论<\/strong>/.test(html), '**粗体** 要渲染成 <strong>');
  assert.ok(/<code>备份要离线<\/code>/.test(html), '`行内代码` 要渲染成 <code>');
  assert.ok(/<ul class="wb-md-ul">[\s\S]*?<li>第一步<\/li>/.test(html), '- 列表要渲染成 <ul><li>');
  assert.ok(/<blockquote class="wb-md-quote">[\s\S]*?引用一句/.test(html), '> 引用要渲染成 <blockquote>');
  assert.ok(/<a href="https:\/\/example\.com"[^>]*>好链<\/a>/.test(html), 'https 链接要放行');
  assert.ok(!/href="javascript:/.test(html), 'javascript: 链接绝不许出现 href（XSS 钉子）');
  assert.ok(/javascript:alert\(1\)/.test(html), '被退化的坏链按纯文本字面显示，不吞内容');
  assert.ok(!/<script>alert\(2\)<\/script>/.test(html), '原始 <script> 不允许以可执行形态出现');
  assert.ok(/&lt;script&gt;alert\(2\)&lt;\/script&gt;/.test(html), '原始 HTML 必须转义成字面文本');
  assert.ok(/<pre class="wb-md-pre" data-lang="js">[\s\S]*?&lt;b&gt;/.test(html),
    '围栏代码块带语言标签、块体内 HTML 也转义');
});

await t('工具卡富格式：JSON 入参/结果美化，短内容保持内联（不破坏既有钉子）', async () => {
  const { dom, sandbox, calls } = await openWorkbench();
  dom.byId('wb-input').value = '工作台你好';
  await sandbox.window.App.wbSend();
  await settle(calls);
  // 0.21.9：工具卡在会话框的「轨迹」页签里（消息流只留正文）—— 断言前先切过去
  const html = openTrace(dom, sandbox);
  // stub.echo 的入参 {text:'工作台你好'} 美化后是 3 行 JSON（28 字符 < 280）→ 内联 code；
  // "工作台你好" 作为结果的短字符串同理。短内容走内联是为了可读性，
  // 长 JSON 走折叠（同一函数内的 >280 分支，不在此重复钉）。
  // 注意 JSON 里的双引号经 esc() 变成 &quot; —— 断言按**渲染后的 HTML 实体**写。
  assert.ok(/<code class="wb-tool-inline">\{\s*&quot;text&quot;: &quot;工作台你好&quot;\s*\}<\/code>/.test(html),
    '工具入参 JSON 要美化成内联 code，实际片段：'
    + (html.match(/wb-tool-inline[\s\S]{0,80}/) || ['（没有 wb-tool-inline）'])[0]);
  assert.ok(/<code class="wb-tool-inline">工作台你好<\/code>/.test(html), '短字符串结果保持内联');
  assert.ok(/wb-tool-name/.test(html), '工具名要有独立样式类');
});

await t('工作台实时路径：注入段不进气泡、思考块进"推理过程"折叠区（与回放共用同一份拆分）', async () => {
  // 0.15.1 真机审计抓到的漂移：**回放**路径剥了注入段，**实时**路径没剥 ——
  // 结果是用户在自己的提问气泡里看到整段知识库参考资料，而且原话重复了两遍。
  // 这条用例用一份独立的帧序列把"实时"这条路单独钉住。
  const nd = [
    JSON.stringify({ kind: 'meta', sessionId: WB_SID }),
    JSON.stringify({ kind: 'turn', turnId: 'kt-9', accepted: true }),
    JSON.stringify({ kind: 'event', event: { seq: 1, type: 'turn-start', role: 'user', text: '', known: true } }),
    // 真实形态：user 事件 = 用户原话 + 平台注入的知识段（标记一字不差）
    JSON.stringify({ kind: 'event', event: { seq: 2, type: 'message', role: 'user',
      text: '备份怎么做？\n\n<<<STI-KNOWLEDGE>>>\n【企业知识库参考资料】\n\n[1] 手册.txt\n备份页一键创建 ZIP 备份，恢复必须离线执行。', known: true } }),
    // 真实形态：assistant/message 带拆分后的两个字段（契约层按上游块类型拆的）
    JSON.stringify({ kind: 'event', event: { seq: 3, type: 'message', role: 'assistant',
      text: '在备份页一键创建 ZIP 备份，恢复必须离线执行。',
      reasoning: '先查知识库，命中 [1]。', known: true } }),
    JSON.stringify({ kind: 'event', event: { seq: 4, type: 'turn-end', role: 'assistant', text: 'done', known: true } }),
    JSON.stringify({ kind: 'done', eventsWritten: 4, lastSeq: 4, truncated: false,
      usageCollected: { written: 0, skipped: 0, totals: null }, artifactsRecorded: { written: 0, error: null },
      attachments: { requested: 0, sent: [], injected: [], skipped: [], missing: [] } }),
  ].join('\n') + '\n';
  // ⚠️ 必须 wbOverrides(...) 合并而不是整体替换：只给流接口一条 override 会把
  // 会话列表 / 会话详情 / 模型目录的录制全丢掉 —— 工作台退回"新建会话"，
  // 流接口的 key 就对不上了（页面显示"这条路径没有被录制"）。
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({ ['POST /api/kernel/sessions/' + WB_SID + '/turns/stream']: { status: 200, text: nd } }),
  });
  dom.byId('wb-input').value = '备份怎么做？';
  await sandbox.window.App.wbSend();
  await settle(calls);
  const html = dom.state.html;

  // ⚠️ 只查**用户气泡**内部（与回放路径那条用例同一口径）：注入段出现在「轨迹」
  // 折叠里是**对的** —— 轨迹就是平台实际发出去的原文，必须等于事实。
  const bubbles = [...html.matchAll(/<div class="wb-bubble">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.ok(bubbles.length >= 1, '应有用户气泡');
  assert.ok(!bubbles.some((b) => /【企业知识库参考资料】/.test(b)),
    '用户气泡里不许出现平台注入的资料段 —— 它是发给模型的资料，不是用户打的字');
  assert.ok(bubbles.some((b) => /备份怎么做？/.test(b)), '用户原话要在气泡里');
  assert.ok(/在备份页一键创建 ZIP 备份/.test(html), '助手正文要显示');
  // 0.21.9：消息流**只留正文** —— 推理折叠不该再出现在这一份
  //（这份 html 取的是「对话」页签，也就是"用户看到的对话区"）。
  assert.ok(!/wb-reasoning|class="wb-tools"/.test(html),
    '「对话」页签里不许再有推理折叠 / 工具卡（它们已搬到「轨迹」页签）');
  // 思考过程有专门的折叠区，只是换了地方；若它混进了正文（旧行为），轨迹里也找不到独立的折叠区
  const trace = openTrace(dom, sandbox);
  // ⚠️ 0.21.12 修正：渲染出来的是 `<details class="wb-reasoning" open>` —— 带 `open` 属性
  //    （推理折叠默认展开，见 84-workbench.js 的 wbReasoningHtml）。旧正则写成
  //    `<details class="wb-reasoning">`，要求类属性后面**紧跟 `>`**，于是恒不匹配 ——
  //    它其实**从来没验过推理折叠**，只是在"正文里出现这段文字"时才恰好通过另一条路径。
  //    判据改成"类名之后允许还有别的属性"。
  assert.ok(/<details class="wb-reasoning"[^>]*>[\s\S]*?先查知识库，命中/.test(trace),
    '思考块应进"推理过程"折叠区（现在住在会话框的「轨迹」页签里），而不是被当成答案正文');
});

await t('回放多轮历史（turn-start 不带文本的真实形态）：每轮的提问落在自己的气泡里，不并成一个大杂烩', async () => {
  // 真实上游的 turn-start **不带**用户文本，用户的话由随后的 role=user 的
  // message 事件带来。此前 wbAppendToUserBubble 从消息流末尾全局找"最近一条
  // 用户气泡"，无视回合边界 —— 两轮历史回放出来只有一个气泡，三轮原话糊在一起。
  const history = [
    { seq: 1, type: 'turn-start', role: 'user', text: '', known: true },
    { seq: 2, type: 'message', role: 'user', text: '第一问：备份怎么做？', known: true },
    { seq: 3, type: 'message', role: 'assistant', delta: '答一：离线执行。', known: true },
    { seq: 4, type: 'turn-end', role: 'assistant', text: 'done', known: true },
    { seq: 5, type: 'turn-start', role: 'user', text: '', known: true },
    { seq: 6, type: 'message', role: 'user', text: '第二问：恢复怎么做？', known: true },
    { seq: 7, type: 'message', role: 'assistant', delta: '答二：也必须离线。', known: true },
    { seq: 8, type: 'turn-end', role: 'assistant', text: 'done', known: true },
  ];
  const { dom } = await openWorkbench({
    overrides: wbOverrides({
      ['GET /api/kernel/sessions/' + WB_SID + '/events']: { status: 200, body: { items: history, count: history.length } },
    }),
  });
  const html = dom.state.html;
  const bubbles = [...html.matchAll(/<div class="wb-bubble">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.ok(bubbles.length === 2, '两轮历史应有两个用户气泡，实际 ' + bubbles.length + ' 个：'
    + bubbles.map((b) => b.slice(0, 30)).join(' | '));
  assert.ok(/第一问/.test(bubbles[0]) && !/第二问/.test(bubbles[0]), '第一个气泡只有第一轮的提问');
  assert.ok(/第二问/.test(bubbles[1]) && !/第一问/.test(bubbles[1]), '第二个气泡只有第二轮的提问');
  assert.ok(/答一：离线执行/.test(html) && /答二：也必须离线/.test(html), '两轮的助手回答都要在');
});

await t('viewer（无 session:execute）：发送按钮禁用，并如实标注只读', async () => {
  const perms = wbMemberPerms();
  perms.session = { read: true };
  const { dom, calls } = await openWorkbench({ permissions: perms });
  const html = dom.state.html;
  assert.ok(/只读/.test(html), '应标注为只读（不能发起对话）');
  assert.ok(/不能发起对话/.test(html), '应如实说明当前角色不能发起对话');
  assert.ok(/data-act="wbSend"[^>]*\bdisabled\b/.test(html), '发送按钮应禁用');
  assert.ok(dom.byId('wb-input'), '输入框仍应渲染（可查看历史）');
  assert.ok(/历史上的一个问题/.test(html), '只读角色仍能看到历史对话');
  // 只读角色不应发起任何写请求
  assert.ok(!calls.some((c) => c.startsWith('POST /api/kernel/sessions')), '只读角色不得发出提交请求');
});

await t('权限收敛：无 artifact 权限时不请求产物接口', async () => {
  const { calls } = await openWorkbench();
  assert.ok(!calls.some((c) => c.includes('/api/governance/artifacts')), '不应请求产物接口');
});

await t('流式接口失败：错误显示在该条消息上，不炸整页', async () => {
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['POST /api/kernel/sessions/' + WB_SID + '/turns/stream']: {
        status: 403, body: { ok: false, error: { code: 'quota_blocked', message: '配额已达标，本次操作被治理策略拦截' } },
      },
    }),
  });
  dom.byId('wb-input').value = '应被拦';
  await sandbox.window.App.wbSend();
  await settle(calls);
  const html = dom.state.html;
  assert.ok(/配额已达标/.test(html), '被治理拦截的原因应显示出来（不是无声失败）');
  assert.ok(/id="wb-input"/.test(html), '页面仍应正常渲染');
});

/* ── 工作台最后一公里（3.6）：附件 / 发送 / 停止 ───────────────
 * ⚠️ 0.21.9：本小节标题里的"重生成"已随该功能删除，但**小节名仍叫"最后一公里"** ——
 *    它指的是"从输入框到上游跑完"这条链，与具体有几个入口无关。 */

section('工作台最后一公里（3.6）：附件、发送、停止');

await t('契约对账：附件注入标记在服务端与前端**一字不差**（只改一边就红）', () => {
  const srv = fs.readFileSync(path.join(ROOT, 'app', 'http', 'routes', 'kernel.mjs'), 'utf8');
  const cli = readAppSource();   // 这两条跨端契约的常量在前端分片里，扫全部分片
  const pick = (src, name) => {
    const m = new RegExp('const ' + name + " = '([^']*)'").exec(src);
    assert.ok(m, '找不到常量 ' + name);
    return JSON.parse('"' + m[1] + '"');        // 还原 \n 等转义，比字面量比对更准
  };
  const a = pick(srv, 'ATTACH_INJECT_BEGIN');
  const b = pick(cli, 'WB_ATTACH_MARKER');
  assert.equal(b, a, '前端 WB_ATTACH_MARKER 必须与服务端 ATTACH_INJECT_BEGIN 完全一致 —— '
    + '不一致的话，用户气泡里会糊进整份附件正文（或反过来，注入段被当成了用户说的话）');
  assert.ok(a.includes('STI-ATTACHMENTS'), '标记本身要可辨认：' + JSON.stringify(a));

  // 识别用的**形态**正则：写出去的是规范标记，但**识别**必须也能认更名前落库的旧形态，
  // 否则历史会话的气泡会被整段注入正文糊满（数据没错，是没法看）。
  const rm = /WB_ATTACH_MARKER_RE = \/(.+?)\/;/.exec(cli);
  assert.ok(rm, '找不到 WB_ATTACH_MARKER_RE');
  const re = new RegExp(rm[1]);
  assert.ok(re.test(a), '规范标记必须被识别正则认下');
  assert.ok(re.test('\n\n<<<ZZZ-ATTACHMENTS>>>\n'), '更名前那种形态的标记也要认（历史会话仍可读）');
  assert.ok(!re.test('<<<sti-attachments>>>'), '小写形态**不**认 —— 免得把随口打的东西当标记');
});

await t('契约对账：知识注入标记在服务端与前端**一字不差**（第三对跨端契约，0.14.0）', () => {
  // 与上面那条附件标记同一对纪律：服务端写出去的 `KB_INJECT_BEGIN` 与前端识别用的
  // `WB_KB_MARKER` 必须一字不差 —— 改一边不改另一边，用户气泡里会糊进整段知识命中片段。
  // （服务端 `kernel.mjs` 那条常量注释也点名了这个用例，见 §7.7。）
  const srv = fs.readFileSync(path.join(ROOT, 'app', 'http', 'routes', 'kernel.mjs'), 'utf8');
  const cli = readAppSource();
  const pick = (src, name) => {
    const m = new RegExp('const ' + name + " = '([^']*)'").exec(src);
    assert.ok(m, '找不到常量 ' + name);
    return JSON.parse('"' + m[1] + '"');
  };
  const a = pick(srv, 'KB_INJECT_BEGIN');
  const b = pick(cli, 'WB_KB_MARKER');
  assert.equal(b, a, '前端 WB_KB_MARKER 必须与服务端 KB_INJECT_BEGIN 完全一致');
  assert.ok(a.includes('STI-KNOWLEDGE'), '标记本身要可辨认：' + JSON.stringify(a));
  assert.ok(a !== pick(srv, 'ATTACH_INJECT_BEGIN'),
    '知识标记与附件标记必须是**两个不同**的字面量 —— 否则前端分不出哪段是哪段');

  // 剥注入段必须用**通用形态**正则**一次**切干净：一轮同时注入"知识 + 附件"时，
  // content 的形状是 `用户原文 + 知识段 + 附件段`，分两次剥会让知识段留在气泡里被当成用户打的字。
  const rm = /WB_INJECT_MARKER_RE = \/(.+?)\/;/.exec(cli);
  assert.ok(rm, '找不到 WB_INJECT_MARKER_RE');
  const re = new RegExp(rm[1]);
  assert.ok(re.test(a), '知识标记必须被通用正则认下');
  assert.ok(re.test(pick(srv, 'ATTACH_INJECT_BEGIN')), '附件标记也要被同一条通用正则认下');
  assert.ok(re.test('\n\n<<<ZZZ-KNOWLEDGE>>>\n'), '更名前那种前缀形态的知识标记也要认（历史会话仍可读）');
  assert.ok(!re.test('<<<STI-SOMETHINGELSE>>>'), '不认其它类别（只有 KNOWLEDGE / ATTACHMENTS 两类会被注入）');
  assert.ok(!re.test('<<<sti-knowledge>>>'), '小写形态**不**认');
});

await t('契约对账：图片清单行在服务端与前端**同一句话**（回放数图靠它对得上）', () => {
  // 这是**第二条**跨端契约（第一条是上面的注入标记）。
  // 服务端 describeImages() 产出"本轮随附 N 张图片…"，前端 WB_IMAGES_RE 从落库正文里
  // 把它读回来 —— 这样"实时"和"回放"渲染出的气泡数字才一致，也不会出现
  // "另存一个 imageCount 字段、结果字段与正文互相矛盾"的情况。
  // 改一边不改另一边，用户气泡上的图片数就会**静默变成 0** —— 所以这里要钉死。
  const srv = fs.readFileSync(path.join(ROOT, 'app', 'platform', 'attachment', 'content.mjs'), 'utf8');
  const cli = readAppSource();   // 这两条跨端契约的常量在前端分片里，扫全部分片

  const srvLine = /return '(本轮随附 )' \+ images\.length \+ '( 张图片)/.exec(srv);
  assert.ok(srvLine, 'describeImages 的输出前缀变了？没找到预期的那句拼接');
  const prefix = srvLine[1];
  const suffix = srvLine[2];

  const reM = /const WB_IMAGES_RE = \/([^/]+)\//.exec(cli);
  assert.ok(reM, '前端找不到 WB_IMAGES_RE');
  const reSrc = reM[1];

  assert.ok(reSrc.includes(prefix), '前端正则必须含服务端的前缀「' + prefix + '」：实际 ' + JSON.stringify(reSrc));
  assert.ok(reSrc.includes(suffix), '前端正则必须含服务端的后缀「' + suffix + '」：实际 ' + JSON.stringify(reSrc));
  assert.ok(/\\d\+/.test(reSrc), '前端正则必须把数字抓出来（否则只会知道"有图"、不知道几张）');

  // 正面验证：用服务端那套字面量拼一句，前端正则必须能读出 3
  const sample = prefix + 3 + suffix + '：\n  · a.png（png，1.0KB）';
  const re = new RegExp(reSrc);
  const got = re.exec(sample);
  assert.ok(got, '前端正则匹配不上服务端的真实输出形态');
  assert.equal(got[1], '3', '数字要抓对');
});

await t('附件入口的静态形态：文件选择框走 data-change，且页面没有任何内联事件属性', async () => {
  const { dom } = await openWorkbench();
  const html = dom.state.html;
  const file = dom.byId('wb-file');
  assert.ok(file, '应有文件选择框 #wb-file');
  assert.ok(/data-change="wbFilesChosen"/.test(html), '文件选择要挂 data-change（事件委托），不是 onchange');
  assert.ok(/data-act="wbPickFiles"/.test(html), '应有「＋附件」按钮');
  // 0.21.7：会话内检索整块删除 —— 这里原本还断言「搜索」按钮与 #wb-q 输入框存在。
  // 现在反着钉：DOM 里一点痕迹都不许留（按钮、输入框、动作都删干净了）。
  assert.ok(!/wbRunSearch|wb-q\b|wb-search/.test(html),
    '会话内检索已整块删除 —— 按钮 / 输入框 / 面板样式类都不该再出现');
  assert.ok(!/\bon(?:click|change)\s*=/.test(html), '3.6 新增的交互也不许回到内联事件属性（CSP 的 script-src 已不含 unsafe-inline）');
});

await t('附件：列表按服务端为准渲染三种结局；勾选与删除都真的打到接口', async () => {
  const { dom, sandbox, calls } = await openWorkbench();
  const w36 = globalThis.__wb36 || {};
  const textId = w36.textId || 'att_rec_text';
  const imgId = w36.imgId || 'att_rec_img';
  let html = dom.state.html;
  assert.ok(/规格\.txt/.test(html) && /图\.png/.test(html) && /真图\.png/.test(html), '三个附件都要渲染');

  // 三种结局必须**看得见地区分开**，否则用户以为所有附件待遇一样：
  //   · 图片   → 送给模型（模型能直接看到）
  //   · 文本   → 正文注入上下文
  //   · 其余   → 不提交给模型，只登记与下载
  assert.ok(/送给模型/.test(html), '图片要标出「送给模型」—— 这是它与通用文件的关键区别');
  assert.ok(/不提交/.test(html), '不会交给模型的附件必须标出来，否则用户以为文件已经给模型了');
  assert.ok(/data-act="wbToggleAttach"/.test(html), '每个附件都应可勾选进本轮');

  // 勾选：纯状态切换（不发请求），且**分类计数**要对
  const before = calls.length;
  sandbox.window.App.wbToggleAttach(imgId);
  html = dom.state.html;
  assert.ok(/1 张图片送给模型/.test(html),
    '勾选图片后要按"图片"这一类计数，不能笼统说"1 个附件"：' + html.replace(/\s+/g, ' ').slice(0, 300));
  sandbox.window.App.wbToggleAttach(textId);
  html = dom.state.html;
  assert.ok(/1 张图片送给模型/.test(html) && /1 个附件正文注入/.test(html),
    '两类要并列显示（它们的结局不同，不能合并成一个数）');
  // 取消勾选后那一类不该再计数
  sandbox.window.App.wbToggleAttach(imgId);
  sandbox.window.App.wbToggleAttach(textId);
  assert.ok(!/本轮将/.test(dom.state.html), '全部取消勾选后不该再显示"本轮将 …"');
  assert.equal(calls.length, before, '勾选/取消是纯前端状态，不该发请求');

  // 删除：真的打 DELETE，并按服务端回报（bytesDeleted）给反馈
  await sandbox.window.App.wbDeleteAttach('att_demo_1');
  await settle(calls);
  assert.ok(calls.some((c) => c === 'DELETE /api/kernel/sessions/' + WB_SID + '/attachments/att_demo_1'),
    '删除要打到 DELETE 接口，实际调用：' + JSON.stringify(calls.filter((c) => c.includes('attachments'))));
});

await t('工作台的操作反馈能真的显示出来（notice 曾经写了却从不渲染）', async () => {
  // 这是一个**真实缺陷**的钉住用例：工作台往 `State.wb.notice` 写了 4 处提示
  //（新建会话 / 模型登记 / 附件上传部分失败 / 停止的上游结果），却从来没有渲染过。
  // 最严重的是"模型登记"那条 —— 用户在成本页看到用量进了「未归因」桶，
  // 而界面当时明明想说"已为本会话登记模型：…"，只是没人看得到。
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['POST /api/kernel/sessions/' + WB_SID + '/model']: {
        status: 200,
        body: {
          ok: true, sessionId: WB_SID, provider: 'stub', model: 'stub-deterministic',
          recorded: { modelProvider: 'stub', modelId: 'stub-deterministic' },
          note: '本会话后续回合的用量会归因到这个模型名。',
        },
      },
    }),
  });
  const sel = dom.byId('wb-model');
  assert.ok(sel, '应有模型选择器');
  sel.value = 'stub|stub-deterministic';
  await sandbox.window.App.wbSelectModel();
  await settle(calls);
  const html = dom.state.html;
  assert.ok(/已为本会话登记模型/.test(html),
    '登记模型的确认必须真的渲染出来（这是成本归因能不能用上的关键反馈），实际：'
    + html.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(/归因/.test(html), '还要说明后果：后续回合的用量按这个模型名归因');
});

/* ── 会话内检索：整块删除（0.21.7）─────────────────────────────────────
 *
 * 这里曾有两条用例：「结果面板转述服务端口径、命中可跳转」与「命中不在已加载区间时
 * 如实说明」。它们是一套**完整而正确**的设计（服务端在落库事件里搜 —— 前端只回放最近
 * 2000 条，纯前端过滤会在长会话里给出"搜不到"的错误结论），但用户裁定整块删除
 * （"右上角（会话内搜索删除…）" → 追问时选"整块删除"）。
 *
 * 所以删掉的不只是这两条用例，而是整条链：路由 `kernel.sessions.search`、
 * 仓储 `events.searchEvents`、前端四个动作（wbRunSearch / wbJumpToHit / wbClearSearch /
 * wbToggleSearch）、结果面板 `wbSearchPanelHtml`、命中高亮 `.wb-msg.hit`、State 四个字段、
 * CSS 与录制里那一条 `GET …/search`。要加回来请照当时口径重做（见 kernel.mjs 里那段说明）。
 */


/* ── 重生成：整块删除（0.21.9）────────────────────────────────────────
 *
 * 这里曾有一条用例：「重生成：用最后一条用户输入再跑一轮，并说明它**不撤销**上一轮」。
 * 用户在 2026-10-08 裁定「另外重生成也直接去掉」。
 *
 * 它当时长在**最后一条助手消息**底下（`.wb-msg-ops`），做的是"取回上一次的用户输入，
 * 再提交一次"。删它的判据（完整版见 71-app-workbench.js 里 `wbRegenerate` 那段）：
 *   · **同一件事有两个入口** —— 想再问一遍，输入卡里重新发一次就是同一回事，
 *     而那个入口常驻且显眼；消息底下那颗要翻上去才看得见。
 *   · 它带着一个**只有作者知道的副作用**（不撤销上一轮）。按钮 title 写得很老实，
 *     但一个"要读完 title 才理解得对"的动作，默认读法就是"重来一次、上一条不算"。
 *
 * 一起删掉的：`App.wbRegenerate`、`wbMsgHtml` 末尾的 `.wb-msg-ops` 段、
 * `wbHasTrace`（只服务那句提示）、`style.css` 里 `.wb-msg-ops` 两条规则、
 * `wbRunTurn` 签名里的 `reuseUserBubble`（唯一真调用方就是它）。
 *
 * 下面这条用例**钉住"删干净"**这件事本身：一个删了一半的功能（按钮没了、动作还在）
 * 是最容易在后续被"顺手接回来"的东西，而它接回来时不会有人记得上面那两条判据。
 */
await t('重生成：整块删除（动作与按钮都不得复活）', async () => {
  const { dom, sandbox } = await openWorkbench();
  const html = dom.state.html;
  assert.ok(!/data-act="wbRegenerate"/.test(html), '消息流里不许再有「重生成」按钮');
  assert.ok(!/重生成/.test(html.replace(/<[^>]*>/g, '')), '界面上不许再出现"重生成"这三个字');
  assert.ok(!/wb-msg-ops/.test(html), '`.wb-msg-ops` 那段壳也不许留（留着就是"藏起来的那份"）');
  assert.equal(typeof sandbox.window.App.wbRegenerate, 'undefined',
    '动作也要一起删：只删按钮会留下一份没有入口的实现');
  // 发送仍然要能跑 —— 删重生成不能把唯一的流式实现一起带走。
  assert.equal(typeof sandbox.window.App.wbSend, 'function', '发送必须还在（它是唯一保留的入口）');
});

/* ── 助手"没有正文"那一轮：只留一个高亮光标，不写任何句子（0.21.9）──────────
 *
 * ⚠️ 这条用例钉的是一个**被否掉两版**的措辞坑，别再往回改：
 *   第一版「（本轮没有正文 —— 推理与工具调用见右侧「轨迹」）」
 *     → 用户：「"没有正文"是什么意思」（"正文"是平台内部叫法，界面上别处没用过）。
 *   第二版「这一轮没有文字回复 —— 过程记在「轨迹」选项卡里。」
 *     → 用户：「什么叫没有文字回复，有歧义，直接去掉这行文字」。
 * 歧义的根子：**平台证不了这件事**。消息流这一侧没有正文，只说明助手段落为空
 * （工具卡与推理都在轨迹选项卡里），说成"没有文字回复"是替模型下结论。
 *
 * 现在的口径：**没有正文就什么都不说**，只留一个光标。光标前后改过两次样子：
 *   ① 第一版包了一层 `.wb-idle-caret` 的 inline-flex 外壳 → 用户：
 *     「有的地方下面有个光标的号，然后间距特别大，感觉是外部容器间距的问题」。
 *     原子行内盒 + `vertical-align` 重新对齐，导致"光标飘在一大片空白中间"。
 *   ② 改成"不闪烁的 45% 灰块"（`.wb-caret.idle`）→ 用户：
 *     「那个光标不明显，改成高亮长条或者闪烁光标吧」。灰块与背景对比度太低，
 *     用户读到的是"这块是空的"。
 * ③ 现在 = `.wb-caret.idle`（**没有**外层容器）+ 高亮实心 + 缓慢呼吸。
 *
 * 所以这条用例要钉三件事：句子不在、外壳不在、光标在且是**高亮**的。
 */
await t('助手没有正文：只留一个高亮光标（无外层容器、无句子）', async () => {
  const { dom, sandbox } = await openWorkbench();
  const html = dom.state.html;
  assert.ok(!/没有文字回复/.test(html), '不许再出现「没有文字回复」（用户裁定：有歧义）');
  assert.ok(!/没有正文/.test(html), '也不许出现「没有正文」（平台内部叫法，用户问过"是什么意思"）');
  assert.ok(!/过程记在/.test(html), '指路语也不许有：轨迹就在这个会话框的第二个页签上，不需要一句话指路');

  // 造一条"助手这一轮没有正文"的消息，直接走渲染层验光标本身。
  // ⚠️ 不能拿回放夹具里那条现成的助手消息来验 —— 它有正文（`body` 非空），
  //    根本不会走到这个分支；用它验等于"这条断言没在测东西"（会假绿）。
  //
  // ⚠️ 0.21.12 修正：**必须带一条用户气泡在前面**。0.21.9 起，
  //    "前面一个用户气泡都没有"的助手块会被整块跳过（那是"会话最开头那个空孤儿块"，
  //    用户裁定「每个会话最开始的闪烁的 wb-caret.idle 直接删掉」——
  //    见 84-workbench.js 的 `wbStreamHtml`）。只放一条 assistant 消息，
  //    测到的是那个被删掉的分支，不是"没有正文时留光标"。
  //    （两件事要分清：**开头的空孤儿块**不画；**有回合归属的**没有正文才画光标。）
  runInApp(sandbox, "State.wb.msgs = ["
    + "{ id: 'u-probe', role: 'user', seq: 98, text: '问一句' },"
    + "{ id: 'a-probe', role: 'assistant', seq: 99, text: '', finals: [] }"
    + "]; render();");
  const idleHtml = dom.state.html;
  assert.ok(/<span class="wb-caret idle"><\/span>/.test(idleHtml),
    '没有正文时要留一个 `.wb-caret.idle` 光标：' + idleHtml.replace(/\s+/g, ' ').slice(-400));
  assert.ok(!/wb-idle-caret/.test(idleHtml),
    '**不许**再包一层容器（那层 inline-flex 就是"间距特别大"的来源）');

  // 样式侧：必须是**高亮**的（用户："不明显，改成高亮长条或者闪烁光标"）。
  // ⚠️ 剥注释后再查 —— 上面那段说明里也写了 `--text-faint` 这些词，不剥会假绿。
  // （从前这里还要绕开 `WB_CSS()` 的 TDZ —— 那个 const 现已提到文件头部，理由不成立了。）
  const cssBare = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const idleRule = (/\.wb-caret\.idle\s*\{([^}]*)\}/.exec(cssBare) || [])[1] || '';
  assert.ok(/background:\s*var\(--accent\)/.test(idleRule),
    '光标要用高亮色（--accent）而不是灰：' + idleRule);
  assert.ok(/animation:\s*wb-breathe/.test(idleRule), '要有呼吸动画（"闪烁光标"）。可用的是缓慢呼吸，不是 1s 硬闪 —— 硬闪那个是"正在跑"');
  assert.ok(/@keyframes wb-breathe/.test(cssBare), '呼吸动画本身要定义');
  // 流式中的那一行**必须保留**：它是"正在跑"与"跑完了没正文"的区别所在。
  assert.ok(/正在等待模型响应/.test(readAppSource()),
    '流式中的"正在等待模型响应"要保留（它才是正在跑的标志）');
});

/* ── 回放：turn-end 之后的"无主事件"不许新开助手块（0.21.9）──────────────
 *
 * 真机 bug（用户 2026-10-08）：
 *   「对话完之后显示的样式根本没有这个 wb-caret idle 这个样式，切换会话或者刷新
 *     页面后这条对话才出现这个样式」+ 追问后确认：「正文好好的，下面多出一个空心
 *     长条（像光标，带高亮色，会慢慢呼吸闪烁）」。
 *
 * 根因在 `wbMessagesFromEvents`，**不在渲染层**：上游会话日志里每个 `turn-end`
 * 后面还跟着若干 `lifecycle` 事件（真机落库实测：某会话 10 次 turn-end，10 次后面
 * 都紧跟一个 lifecycle；类型分布 lifecycle 68 / message 27 / turn-start 11 /
 * turn-end 11）。`turn-end` 把游标清空之后，紧接着的 lifecycle 撞上
 * "游标为空就新开一个助手块" → **凭空造出一个没有正文的助手块** →
 * 渲染出来正好就是一个光秃秃的 `.wb-caret.idle`。每轮一个，用户就看到
 * "正文还在、下面多一个会呼吸的空心长条"。
 *
 * 实时为什么没有：`/turns/stream` 不落 lifecycle，且实时路径不按 turn-end 切块。
 * 所以同一个会话"实时一份、回放另一份" —— 这就是用户说的"两套样式"。
 *
 * 这条用例要用**真实的落库形状**（turn-end 后跟 lifecycle）造回放输入，
 * 而不能只用"干净的 turn-start/message/turn-end 三段式" —— 后者测不出这个 bug。
 */
await t('回放：turn-end 之后的无主事件不新开助手块（不再凭空多出一个光标）', async () => {
  const { sandbox } = await openWorkbench();
  // 真实形状：一轮 = turn-start → message(有正文) → turn-end → lifecycle（无主的尾巴）。
  // 再补一轮同样的，验"每一轮都别多"。
  runInApp(sandbox, `
    var mk = function (b, t, txt) {
      return { seq: b, type: t, role: 'assistant', text: txt };
    };
    var evs = [
      { seq: 1, type: 'turn-start', role: 'user', text: '问题一' },
      { seq: 2, type: 'message', role: 'assistant', text: '答案一' },
      { seq: 3, type: 'turn-end', role: 'assistant', text: 'done' },
      { seq: 4, type: 'lifecycle', role: 'system' },              // ← 无主尾巴
      { seq: 5, type: 'turn-start', role: 'user', text: '问题二' },
      { seq: 6, type: 'message', role: 'assistant', text: '答案二' },
      { seq: 7, type: 'turn-end', role: 'assistant', text: 'done' },
      { seq: 8, type: 'lifecycle', role: 'system' },              // ← 无主尾巴
    ];
    State.wb.msgs = wbMessagesFromEvents(evs);
    render();
  `);
  const html = dom2html(sandbox);
  // 两个用户气泡 + 两个助手块 = 4 条消息；无主 lifecycle 不许变成第 5、第 6 条。
  const assistantBlocks = (html.match(/<div class="wb-msg assistant"/g) || []).length;
  assert.equal(assistantBlocks, 2,
    '两轮对话只该有两个助手块；跟在 turn-end 后面的 lifecycle 不许各开一个新块'
    + '（那正是用户看到的"正文好好的，下面多出一个呼吸空心长条"）');
  assert.ok(!/wb-caret idle/.test(html),
    '这两轮都有正文，页面上**不该有任何** `.wb-caret.idle`：'
    + html.replace(/\s+/g, ' ').slice(-500));
  assert.ok(/答案一/.test(html) && /答案二/.test(html), '两轮正文都要在');

  // 反面：`turn-start` 从未出现时（上游只给了中段事件 / 流被截断），
  // 那句"游标为空就新开块"**必须**保留 —— 否则整轮内容会凭空消失。
  // 这是有意留的分支，别在修 bug 时一起删掉。
  runInApp(sandbox, `
    State.wb.msgs = wbMessagesFromEvents([
      { seq: 1, type: 'message', role: 'assistant', text: '没有回合边界的正文' },
      { seq: 2, type: 'usage', role: 'assistant', usage: { input: 1, output: 1 } },
    ]);
    render();
  `);
  const h2 = dom2html(sandbox);
  assert.ok(/没有回合边界的正文/.test(h2),
    'turn-start 从未出现时，中段事件仍要被收进一个块里 —— 不许一起丢掉');

  // ── 反面之反面：**开头那段噪声**要丢，但"流被截断"不许跟着一起丢 ──────────
  //
  // 这两个判据用的是**两个不同的布尔量**，看着像、判的事完全不同：
  //   · `sawTurnStart`：整个流里见过 turn-start 没有 → 管"这条流有没有回合边界"；
  //   · `inFirstTurn`：进过第一个回合没有       → 管"在不在开头那段噪声里"。
  // 我曾把后者写成前者（`!cur && !sawTurnStart`），结果"流被截断"被当成开头噪声
  // 一起丢掉 —— 整轮内容凭空消失。这条用例就是为那次写错立的钉子。
  //
  // 判据落在**行为**上而不是文本上：文本断言会被"改了注释忘了改码"骗过去，
  // 所以这里跑三种真实的落库形状，看块数与内容。
  runInApp(sandbox, `
    State.wb.msgs = wbMessagesFromEvents([
      { seq: 1, type: 'lifecycle', role: 'system' },              // 开头噪声
      { seq: 2, type: 'lifecycle', role: 'system' },              // 开头噪声
      { seq: 3, type: 'turn-start', role: 'user', text: '问题一' },
      { seq: 4, type: 'message', role: 'assistant', text: '答案一' },
      { seq: 5, type: 'turn-end', role: 'assistant', text: 'done' },
      { seq: 6, type: 'lifecycle', role: 'system' },              // 回合后的无主尾巴
    ]);
    render();
  `);
  const h3 = dom2html(sandbox);
  assert.equal((h3.match(/<div class="wb-msg assistant"/g) || []).length, 1,
    '开头的 lifecycle 不许开块，回合后的 lifecycle 也不许 —— 正好只剩第 3 条那个助手块');
  assert.ok(!/wb-caret idle/.test(h3),
    '会话最开头那个闪烁的 .wb-caret.idle 要**直接删掉**（用户 2026-10-08 的原话）: '
    + h3.replace(/\s+/g, ' ').slice(-400));
  assert.ok(/答案一/.test(h3), '而这一轮的正文当然要在');
});

/* ── 滚动：一轮结束后不许跳到顶部（0.21.9）────────────────────────────
 *
 * 用户 2026-10-08：「另外每次对话完自动给我滚动到会话最上面去啦」。
 *
 * 根因：`wbPaint` 从前在**写 innerHTML 之后的同一帧**里读 `scrollHeight`。
 * 写 innerHTML 只是挂节点，浏览器还没重排；同一同步块里读尺寸会强制同步重排，
 * 而在"内容刚被整体替换"的窗口里读到的是旧的/0 的高度。`scrollTop` 的上限是
 * `scrollHeight - clientHeight`，读到 0 上限就是 0 → 被赋成 0 → **跳到顶部**。
 *
 * 修法：把滚动推迟到下一帧（`requestAnimationFrame`）。
 * ⚠️ 这条用例必须**同时**钉住"推迟"这个动作本身 —— 只断言"调用了 rAF"太弱，
 *    要断言"rAF 回调里才写 scrollTop"。
 */
await t('滚动：滚到底推迟到重排之后（不在写 innerHTML 的同一帧里读 scrollHeight）', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app', '71-app-workbench.js'), 'utf8');
  // ⚠️ 剥注释要**两种都剥**：块注释 `/* */` 与**行尾**的 `// …`。
  //    只剥"整行以 // 开头"是不够的 —— 行尾那半句会留着被当成代码匹配（假红）。
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // 锚在**方法定义**上（`wbPaint() {`），不是调用点 `App.wbPaint();` ——
  // 文件里第一个 `wbPaint()` 是 wbLoadHistory 里的调用，锚错了会切到别人身上。
  const i = stripped.indexOf('wbPaint() {');
  assert.ok(i > 0, '找不到 wbPaint 的定义');
  const body = stripped.slice(i, stripped.indexOf('\n  },', i));

  // ── 0.21.9 第二轮：滚动的实现**搬去了唯一的那个函数**（`wbStickToBottom`）──
  //
  // 用户第二条滚动反馈（「每次对话提交后就跑到会话的最上面」）暴露出：
  // 真正把画面拽到顶部的是 **`render()` 重建 `#wb-stream` 这个元素本身**
  // （新节点 `scrollTop` 天然是 0），而不是 `wbPaint` 里的滚动时机。
  // 所以判据从"wbPaint 里怎么滚"升级成"**谁在滚、有几处**"：
  //   ① 实现必须**只有一处**（`wbStickToBottom`），否则两处判据必然漂移；
  //   ② `wbPaint` 与 `render()` 的工作台分支**都要调它**。
  assert.ok(/wbStickToBottom\(el\)/.test(body),
    'wbPaint 要调 wbStickToBottom（把刚写完的那个节点传进去）: ' + body.slice(0, 300));
  // wbPaint 里**不许**再有自己那份 scrollTop/scrollHeight 读写 —— 那就是第二处手抄。
  assert.ok(!/\.scrollTop\s*=/.test(body) && !/scrollHeight/.test(body),
    'wbPaint 里不许留第二份滚动实现（实现只在 wbStickToBottom 里）: ' + body);

  // ── 实现本身：必须在 rAF 里、且 scrollTop 赋值在 rAF 回调内部 ────────────
  const src84 = fs.readFileSync(path.join(ROOT, 'public', 'app', '84-workbench.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const k = src84.indexOf('function wbStickToBottom');
  assert.ok(k > 0, '找不到 wbStickToBottom（滚动实现的唯一真相源）');
  const impl = src84.slice(k, src84.indexOf('\n}', k));
  assert.ok(/requestAnimationFrame\(/.test(impl),
    '滚到底必须走 requestAnimationFrame（推迟到浏览器重排之后）: ' + impl.slice(0, 300));
  assert.ok(/\.scrollTop\s*=\s*\w+\.scrollHeight/.test(impl),
    'rAF 回调里要真的写 `scrollTop = scrollHeight`（滚到底）: ' + impl.slice(0, 300));
  // 「轨迹」页签不滚的判据只允许在**这一处**，调用点不许各判一次。
  assert.ok(/viewTab === 'trace'/.test(impl),
    '「轨迹」页签不滚的判据要在实现里做一次（调用点各判一次必然漂移）');
  assert.ok(/typeof requestAnimationFrame === 'function'/.test(impl),
    '要给"没有 rAF 的环境"留一条退路（测试替身 / 极老环境），否则直接抛 ReferenceError');

  // ── render() 的工作台分支也必须调它 ──────────────────────────────────
  // 这是"提交后跑到最上面"的正修：`wbRunTurn` 收尾走的是
  // `render() → wbRefreshContext() → render()`，**全程没有 wbPaint**。
  const src90 = fs.readFileSync(path.join(ROOT, 'public', 'app', '90-start.js'), 'utf8');
  const startStripped = src90.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const wbBranch = startStripped.slice(startStripped.indexOf("cur.id === 'workbench'"));
  assert.ok(/wbStickToBottom\(/.test(wbBranch),
    'render() 的工作台分支必须补一次滚到底 —— 重建 #wb-stream 后新节点 scrollTop 是 0，'
    + '而收尾路径（render→wbRefreshContext→render）全程没有 wbPaint，只靠 wbPaint 兜不住');

  // 沙箱里必须**真的**有 rAF 垫片，否则测试跑的是回退分支、修复路径测不到。
  const { sandbox } = await openWorkbench();
  assert.equal(runInAppType(sandbox, 'requestAnimationFrame'), 'function',
    '沙箱要有 requestAnimationFrame 垫片 —— 否则 wbPaint 走的是回退分支，'
    + '修复后的那条路径在回归里静默测不到（测试会假绿）');
});

/* ── 轮次之间的分隔横线（0.21.9）────────────────────────────────────────
 *
 * 用户 2026-10-08 分两次说定，**第二次改掉了第一次的位置**：
 *   ① 「每轮对话加个横线区分一下」                    → 先画在"提问之前"；
 *   ② 「每轮对话横线是放到大模型回复的上面并标记已完成，用时多少秒
 *      （看是否能取到时间，取不到只显示已完成）」     → 位置改成**回复的上面**，
 *      且线上带状态。
 *
 * 所以判据变成：**每个助手块之前**一条，条上写「已完成」（流式中写「进行中」）。
 * 与"提问之前"在**位置**上其实是同一条缝（一轮 = 用户气泡 → 助手块，
 * "助手块之前" = "用户气泡之后"）；真正变的是这条线的**语义** ——
 * 它是给这个回答盖章，不是"下一轮的开头"。于是计数也变了：
 * 三轮会话 = **3** 条（每个回答各一条），而不是从前的 2 条。
 *
 * ⚠️ 首屏那个孤儿助手块不画线（见下面第二条断言）：它前面一个用户气泡都没有，
 *    给一个空回合盖"已完成"章毫无意义。
 */
await t('轮次分隔线：每个模型回复上面一条并标「已完成」，单轮也要有一条', async () => {
  const { sandbox } = await openWorkbench();

  // 单轮：**要**有一条 —— 它是给这个回答盖的章，不是"轮与轮之间的缝"。
  runInApp(sandbox, `
    State.wb.msgs = [
      { id: 'u1', role: 'user', seq: 1, text: '问题一' },
      { id: 'a1', role: 'assistant', seq: 2, text: '答案一' },
    ];
    render();
  `);
  const single = dom2html(sandbox);
  assert.equal((single.match(/wb-turn-sep/g) || []).length, 1,
    '只有一轮会话也要有一条（它是"回答已完成"的章）: ' + single.match(/wb-turn-sep/g));
  assert.ok(/已完成/.test(single), '落定的那一轮要标「已完成」');
  // 用时取不到 → 只显示状态，不许显示"用时 0 秒"（那是假信息，详见 84-workbench.js 的查证记录）
  assert.ok(!/用时/.test(single),
    '当前取不到真实用时，就该**只**显示「已完成」—— 不许编一个数字出来: ' + single);

  // 三轮：每个助手块各一条 = 共 3 条
  runInApp(sandbox, `
    State.wb.msgs = [
      { id: 'u1', role: 'user', seq: 1, text: '问题一' },
      { id: 'a1', role: 'assistant', seq: 2, text: '答案一' },
      { id: 'u2', role: 'user', seq: 3, text: '问题二' },
      { id: 'a2', role: 'assistant', seq: 4, text: '答案二' },
      { id: 'u3', role: 'user', seq: 5, text: '问题三' },
      { id: 'a3', role: 'assistant', seq: 6, text: '答案三' },
    ];
    render();
  `);
  const html = dom2html(sandbox);
  assert.equal((html.match(/wb-turn-sep/g) || []).length, 3,
    '三轮会话 = 3 条分隔线（每个模型回复上面各一条）: ' + html.match(/wb-turn-sep/g));
  // 位置：第一条必须在「答案一」**之前**、且在「问题一」**之后**
  // （= 夹在提问与该提问的回答之间，就是"回复的上面"）。
  const iQ1 = html.indexOf('问题一');
  const iSep = html.indexOf('wb-turn-sep');
  const iA1 = html.indexOf('答案一');
  assert.ok(iSep > iQ1 && iSep < iA1,
    '第一条分隔线要夹在「问题一」和「答案一」之间（画在回复上面，不是提问上面）');
  // role=separator 是给读屏用户的语义（否则那道线对屏幕阅读器不存在）。
  assert.ok(/role="separator"/.test(html), '分隔线要有 role="separator" 语义');

  // 孤儿块（turn-start 之前的空助手块）不画线 —— 它前面没有用户气泡。
  runInApp(sandbox, `
    State.wb.msgs = [
      { id: 'orphan', role: 'assistant', seq: 4, text: '' },
      { id: 'u1', role: 'user', seq: 5, text: '问题一' },
      { id: 'a1', role: 'assistant', seq: 6, text: '答案一' },
    ];
    render();
  `);
  assert.equal((dom2html(sandbox).match(/wb-turn-sep/g) || []).length, 1,
    '开头那个孤儿块不许画分隔线（给空回合盖"已完成"章没有意义）');

  // 样式侧：必须有规则，且不能用高亮色（那是"选中"的语义，会像每轮都被选中）。
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // 0.21.9：这条线从一个 1px 的裸 div 改成了 flex 容器（标签 + 画线的伪元素），
  // 所以规则里已经**没有** `background` 了 —— 颜色落在画线的那一侧伪元素上。
  // ⚠️ 伪元素是 `::after`（标签在 DOM 里写在线**之前**，线由 `::after` 补在末尾），
  //    别去猜 —— `::before`/`::after` 弄反了线就跑到标签上面去。
  const rule = (/\.wb-turn-sep\s*\{([^}]*)\}/.exec(css) || [])[1] || '';
  const bar = (/\.wb-turn-sep::after\s*\{([^}]*)\}/.exec(css) || [])[1] || '';
  assert.ok(rule.length > 0, 'style.css 里要有 .wb-turn-sep 规则');
  assert.ok(/background:\s*var\(--border\)/.test(bar),
    '那条线要用 --border（结构性分隔），不是 --accent: ' + bar);
  assert.ok(!/--accent/.test(rule + bar), '别用高亮色 —— 那读起来像"每一轮都是当前选中"');
  // ── 标签在**线的上方**，不是和线同一行（用户 2026-10-08 第三次纠正）────────
  //    「横线的左上面，是上面，不是和横线在一行」。
  //    判据是布局方向：必须是 `flex-direction: column` —— 只有纵向排列才能
  //    "标签一行、线一行"。默认的 row（或显式 row）会让"已完成 —————"读成一行元信息，
  //    那正是用户否掉的形态。这条断言就是为那次返工立的钉子：
  //    我上一版写的是 `display: flex; align-items: center`（row），看着没错但语义错了。
  assert.ok(/flex-direction:\s*column/.test(rule),
    '标签要在线的**上方**（两行），所以分隔条必须是 column —— 不是和横线同一行(row)。'
    + ' 用户原话：「横线的左上面，是上面，不是和横线在一行」: ' + rule);
  assert.ok(!/flex-direction:\s*row/.test(rule),
    '不许是 row —— 那会把标签与横线摆成同一行（已被用户否掉的形态）: ' + rule);
  // 左上角：交叉轴起点对齐（column 下水平方向靠左）
  assert.ok(/align-items:\s*flex-start/.test(rule),
    '标签要贴左上角（column 下 align-items: flex-start 才是靠左）: ' + rule);
  // 线要横贯整行：column 下不能再用 `flex: 1`（那是主轴方向，会变成"变高"），
  // 正确写法是 `align-self: stretch`（拉满交叉轴 = 宽度）。
  assert.ok(/align-self:\s*stretch/.test(bar),
    'column 下横线要用 align-self: stretch 拉满宽度（用 flex:1 会变高不变宽）: ' + bar);
  const meta = (/\.wb-turn-sep \.wb-turn-meta\s*\{([^}]*)\}/.exec(css) || [])[1] || '';
  assert.ok(/flex:\s*0 0 auto/.test(meta),
    '标签要 `flex: 0 0 auto`（不许被线挤扁、也不许跟着伸缩）: ' + meta);
  assert.ok(!/order\s*:/.test(rule),
    '别用 `order` 把标签翻到前面 —— 它只改视觉位置、不改读屏顺序，'
    + '会让屏幕阅读器先念线再念状态。标签在 DOM 里写在前面即可: ' + rule);
  // DOM 顺序：标签必须出现在横线**之前**（横线由 ::after 生成、不在 DOM 里，
  // 所以直接钉住"分隔条里标签是唯一的子元素且在开头"）。
  assert.ok(/<div class="wb-turn-sep[^"]*" role="separator"><span class="wb-turn-meta">/
    .test(html),
    '分隔条的第一个子元素要是标签（线由 CSS 的 ::after 补在末尾）: '
    + (html.match(/<div class="wb-turn-sep[^>]*>[\s\S]{0,80}/) || [])[0]);
});

await t('滚动：打开会话 / 切会话后默认停在最新（最下面）', async () => {
  // 「查看每个对话默认查看最新」—— 与"提交后停在最新"是同一件事的两面，
  // 都由 render() 工作台分支的那一次 wbStickToBottom 兜住。
  const src90 = fs.readFileSync(path.join(ROOT, 'public', 'app', '90-start.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const wbBranch = src90.slice(src90.indexOf("cur.id === 'workbench'"));
  assert.ok(/wbStickToBottom\(/.test(wbBranch),
    '打开会话（render 重建 #wb-stream）之后要补滚到底，否则停在最上面');
  // ⚠️ 不许沿用侧栏那套"存旧值再恢复"的写法：#wb-stream 已被换掉，
  //    旧节点的 scrollTop 读出来没意义（而且正是"恢复成 0"的来源）。
  assert.ok(!/#wb-stream/.test(wbBranch) || !/savedWb/.test(wbBranch),
    '消息流不该用"保持原处"的语义 —— 它的语义是"永远停在最新一轮"');
});

await t('用户气泡剥掉平台注入的附件正文，并把"图片"与"注入正文"分开标注', async () => {
  const { dom, sandbox } = await openWorkbench();
  const html = dom.state.html;
  assert.ok(/请阅读附件 REC-36/.test(html), '用户输入要显示');
  // ⚠️ 只查**用户气泡**内部。注入段出现在「轨迹」里是**对的** ——
  // 轨迹就是"平台实际发出去的原文"，它必须等于事实；要被治理的是气泡的显示。
  const bubbles = [...html.matchAll(/<div class="wb-bubble">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.ok(bubbles.length >= 2, '应至少有两个用户气泡（历史那轮 + 附件那轮）');
  const withAttach = bubbles.filter((b) => /REC-36/.test(b));
  assert.equal(withAttach.length, 1, '带附件那一轮的用户气泡应只有一个');
  assert.ok(!/附件正文/.test(withAttach[0]), '气泡里不许出现平台注入的引用块说明');
  assert.ok(!/attachment name=/.test(withAttach[0]), '气泡里不许出现 <attachment> 引用块');
  assert.ok(!/本轮随附/.test(withAttach[0]), '气泡里也不许出现图片清单行（那是给模型的内容，不是用户打的字）');
  assert.ok(withAttach[0].includes('请阅读附件 REC-36'), '气泡要保留用户真正打的字');
  // ★ 反向（0.21.9）：那条回执**不该再住在气泡/对话这一侧**。
  //   `wbInjectReceiptHtml` 的产生物（`＋ N 张图片…`）已按用户裁定搬进「轨迹」——
  //   挂在气泡旁边读起来像用户自己说的话，而它其实是平台的动作（见该函数注释）。
  assert.ok(!/张图片已作为图片块送给模型/.test(html),
    '「对话」页签里不该再有注入/附件的计数条（它已搬进「轨迹」）');

  // 剥掉之后必须标注，否则就是"假装用户只打了那几个字"。
  // 而且**两类必须分开说** —— 图片与注入正文的结局根本不同（前者模型"看见"，
  // 后者模型"读到"），混成一句"＋N 个附件"会掩盖用户最需要知道的差别。
  //
  // ⚠️ 0.21.12 修正：这些回执现在住在「轨迹」页签里，所以要切过去再断言
  //    （与"工具卡/推理过程在轨迹里"同一条 0.21.9 口径）。
  const trace = openTrace(dom, sandbox);
  assert.ok(/张图片已作为图片块送给模型/.test(trace),
    '回执要说明图片是真的作为图片块送出去了（这是与"只登记"的关键区别）');
  assert.ok(/个附件正文已注入本轮上下文/.test(trace), '注入正文要单独说');
  // 数字必须与落库原文对得上：这一轮送 1 张图、注入 1 份文本正文（见录制段的断言）
  assert.ok(/＋ 1 张图片已作为图片块送给模型/.test(trace),
    '图片数要从原文里数对：' + trace.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(/＋ 1 个附件正文已注入本轮上下文/.test(trace), '注入数也要数对');

  // 轨迹里仍应能查到完整原文（否则就是"数据层也被改掉了"，那是另一种撒谎）
  assert.ok(/<<<|STI-ATTACHMENTS|attachment name=/.test(trace), '轨迹里必须保留平台实际发出的原文');
});

await t('停止：既通知上游取消、又断本地读取，并按上游结果显示不同反馈', async () => {
  const { sandbox, calls } = await openWorkbench();
  sandbox.window.App.wbStop();
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/kernel/sessions/' + WB_SID + '/cancel'),
    '停止必须同时打取消接口（只断本地读取的话，上游还在烧 token）：' + JSON.stringify(calls.slice(-6)));

  // 上游取消失败时不能显示成"停好了" —— 这是两个不同的结论
  const ctx2 = await openWorkbench({
    overrides: wbOverrides({
      ['POST /api/kernel/sessions/' + WB_SID + '/cancel']: {
        status: 200,
        body: { ok: true, cancelled: true, turnId: 'kt-1', upstream: { attempted: true, ok: false, error: '上游连接超时' }, eventsAlreadyPersisted: 7, note: '' },
      },
    }),
  });
  ctx2.sandbox.window.App.wbStop();
  await settle(ctx2.calls);
  const html = ctx2.dom.state.html;
  assert.ok(/上游取消失败/.test(html), '上游没停成功必须直说，实际：' + html.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(/上游连接超时/.test(html), '要把上游给的原因带出来');
  assert.ok(/仍在消耗 token/.test(html), '要说清后果（继续花钱），而不是只报一个错');
});

/* ── 工作台会话管理：改名 / 删除 ────────────────────────────────────────
 *
 * 为什么在这层回归：会话的日常对话与管理（改名/删除）**只**在工作台 ——
 * 事件级调试页已删，工作台侧栏是这些操作在前端的唯一入口，
 * 与服务端**同接口、同权限、同语义**；这里钉住的正是这条路径。
 *
 * 两类断言手法：
 *   · 对话框断言从关闭前的快照取（`answer()` 的返回值）—— 弹层文案只能在那里看；
 *   · 服务端状态变化用 getter + onCall 开关模拟（PATCH/DELETE 之后列表接口返回新值），
 *     因此"页面出现新标题/回到空态"只可能来自**重拉**，谁也伪造不了本地乐观更新。
 */

section('工作台会话管理：改名 / 删除（日常在哪儿对话，就在哪儿管会话）');

await t('侧栏会话行操作收在「⋯」里：默认不摊按钮，展开后入口绑定到当前条目', async () => {
  const { dom, sandbox } = await openWorkbench();
  const html = dom.state.html;
  // 0.21.1：一行文本不再被 3~4 个按钮挤成两行 —— 默认只有名字/元信息 + 一个「⋯」
  assert.ok(/data-act="wbToggleRowMenu" data-a1="session" data-a2="ks_workbench_demo"/.test(html),
    '会话行要有「⋯」（参数绑定到条目 id）：' + html.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(!/data-act="wbRenameSession"/.test(html), '未展开菜单时不摊改名按钮');
  await sandbox.window.App.wbToggleRowMenu('session', WB_SID);
  const opened = dom.state.html;
  assert.ok(/data-act="wbRenameSession" data-a1="ks_workbench_demo" data-a2="工作台演示会话"/.test(opened),
    '展开菜单后改名入口要带条目 id 与当前标题（对话框靠它预填）：' + opened.replace(/\s+/g, ' ').slice(0, 600));
  assert.ok(/data-act="wbDeleteSession" data-a1="ks_workbench_demo" data-a2="工作台演示会话"/.test(opened),
    '删除入口同样要绑定条目参数');
  assert.ok(/data-act="wbExportSession"/.test(opened),
    '「导出会话」要在这个菜单里');
  // ★ 0.21.9 反向断言：「移动到…」已按用户裁定整块删除。
  //   它与工作区下拉是**同一件事有两个入口**（`State.wb.wsActiveId` / 会话的 workspaceId）：
  //   在菜单里选一个、再从树上做别的，界面不告诉你哪个算数。
  //   现在改会话归属只有一条路 —— 它记在**建的时候**落下的那个工作区里（在哪一行点＋就建在哪）。
  assert.ok(!/data-act="wbMoveSession"/.test(opened) && !/移动到/.test(opened),
    '菜单里不许再有「移动到…」：' + opened.replace(/\s+/g, ' ').slice(0, 600));
  assert.equal(typeof sandbox.window.App.wbMoveSession, 'undefined',
    '动作也要一起删：只删菜单项会留下一份没有入口的实现');
  assert.equal(typeof sandbox.window.App.wbRenameSession, 'function', 'App.wbRenameSession 必须存在（事件委托按名字找函数）');
  assert.equal(typeof sandbox.window.App.wbDeleteSession, 'function');
  assert.equal(typeof sandbox.window.App.wbToggleRowMenu, 'function');
});

await t('菜单是互斥的：开另一行的「⋯」会把上一行的收起（两排菜单摊开会盖住整棵树）', async () => {
  const { dom, sandbox } = await openWorkbench();
  // ⚠️ 0.21.12 修正：开**非兜底**工作区（`wsp_demo_view`）的菜单。
  //    夹具把 `wsp_demo_full` 标成 `isDefault: true`，它的两项是**禁用且不带 data-act** 的
  //    （见 wbWsMenuHtml 与上面的说明）。用兜底工作区当"先开着的那一排"，
  //    下面第一句 `data-act="wbRenameWs"` 恒为假 —— 互斥这件事就**没验过**：
  //    断言只看"另一行开着"，哪怕上一行的菜单根本没被收起也照样全绿。
  //    换成普通工作区，才真的能区分"开着 / 被收起"两种状态。
  await sandbox.window.App.wbToggleRowMenu('ws', 'wsp_demo_view');
  assert.ok(/data-act="wbRenameWs"/.test(dom.state.html), '工作区菜单先开着');
  await sandbox.window.App.wbToggleRowMenu('session', WB_SID);
  const html = dom.state.html;
  assert.ok(!/data-act="wbRenameWs"/.test(html), '开另一行的菜单要顺手收起上一行');
  assert.ok(/data-act="wbRenameSession"/.test(html), '新开的这行要开着');
  // 再点同一次 = 收起
  await sandbox.window.App.wbToggleRowMenu('session', WB_SID);
  assert.ok(!/data-act="wbRenameSession"/.test(dom.state.html), '点同一行的「⋯」再点一次是收起');
});

await t('改名：对话框预填当前标题；确认后 PATCH 新名，并重拉列表（不做本地乐观改名）', async () => {
  let renamed = false;
  let sentBody = null;
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['PATCH /api/kernel/sessions/' + WB_SID]: {
        status: 200,
        body: { session: { id: WB_SID, title: '改名探针会话', updatedAt: '2026-10-02T00:00:00Z' } },
        onCall(o) { renamed = true; sentBody = o && o.body ? JSON.parse(o.body) : null; },
      },
      // 服务端才是权威：改名后列表接口返回新标题 —— "侧栏出现新标题"只能来自重拉，
      // 前端不做本地乐观改名（那会变成第二份真相）。
      //
      // ⚠️ 0.21.12 修正：这条 override **必须带 `workspaceId`**（还要带上 canManage 一族）。
      //    树是 `sessions.filter(s => s.workspaceId === ws.id)`（见 wbTreeHtml），
      //    少了它这条会话**挂不到任何工作区下面** —— 而 0.21.9「未分组」桶整块删除之后，
      //    没有兜底容器会接住它，于是它在树上**根本不渲染**。
      //    症状正是下面那句 `侧栏显示的标题应是重拉后的新值` 拿到一棵没有会话的树。
      //    夹具必须按**真实响应形状**造（服务端确实回显 workspaceId / canManage / presetId），
      //    否则测到的是"这条会话不存在"，而不是"标题重拉了没有"。
      ['GET /api/kernel/sessions']: {
        status: 200,
        get body() {
          return {
            items: [{
              id: WB_SID, title: renamed ? '改名探针会话' : '工作台演示会话',
              cwd: '', kernelSessionId: 'up-1', eventCount: 3,
              ownerUserId: 'u-demo', isMine: true, canManage: true, manageNeed: 'write',
              workspaceId: 'wsp_demo_full', presetId: 'standard',
              createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:10:00Z',
            }],
            total: 1,
          };
        },
      },
    }),
  });

  const opened = await clickAndAnswer(dom, sandbox,
    { 'data-act': 'wbRenameSession', 'data-a1': WB_SID, 'data-a2': '工作台演示会话' },
    { value: '改名探针会话' });
  assert.ok(/重命名会话/.test(opened), '应弹出改名对话框');
  assert.ok(/value="工作台演示会话"/.test(opened), '输入框要预填当前标题');

  await settle(calls);
  assert.equal(calls.filter((c) => c === 'PATCH /api/kernel/sessions/' + WB_SID).length, 1, '应只发一次 PATCH');
  assert.ok(sentBody && sentBody.title === '改名探针会话', '提交的正是用户输入的新标题：' + JSON.stringify(sentBody));

  const html = dom.state.html;
  assert.ok(/会话已改名为「改名探针会话」/.test(html), '应有成功回执：' + html.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(!/modal-wrap dlg/.test(html), '确认后对话框要关掉');
  // 断言**用户看得到的那一行文字**（0.21.1 起标题不再出现在按钮的 data-a2 上：
  // 操作收进了「⋯」菜单，拿按钮参数当"标题"只能验到实现细节）
  //
  // ⚠️ 0.21.12 修正：`wb-session-title` 那一格**还挂着一个 `title` 属性**
  //    （0.21.9 给会话行加了悬停提示「打开这个会话」，见 wbSessionRowHtml）。
  //    旧正则 `wb-session-title">` 要求类属性后**紧跟 `>`**，于是恒不匹配 ——
  //    这条断言一直靠"其他地方恰好也有这个标题文本"在通过，钉不住真对象。
  //    判据允许类属性后还有别的属性。
  assert.ok(/wb-session-title"[^>]*>改名探针会话</.test(html),
    '侧栏显示的标题应是重拉后的新值（钉住"不乐观改名"）：' + html.replace(/\s+/g, ' ').slice(0, 400));
});

await t('改名：取消＝什么都不做（不发 PATCH，也不改页面标题）', async () => {
  const { dom, sandbox, calls } = await openWorkbench();
  await clickAndAnswer(dom, sandbox,
    { 'data-act': 'wbRenameSession', 'data-a1': WB_SID, 'data-a2': '工作台演示会话' },
    { cancel: true });
  await settle(calls);
  assert.equal(calls.filter((c) => c.startsWith('PATCH /api/kernel/sessions')).length, 0,
    '取消不是"改成空名字"，是根本不该发请求');
  const html = dom.state.html;
  assert.ok(!/会话已改名/.test(html), '取消后不该有成功回执');
  assert.ok(/wb-session-title"[^>]*>工作台演示会话</.test(html), '标题保持原样');
});

await t('改名：原样确认（提交值等于原标题）不发请求 —— 没改动就不该报"已改名"', async () => {
  const { dom, sandbox, calls } = await openWorkbench();
  await clickAndAnswer(dom, sandbox,
    { 'data-act': 'wbRenameSession', 'data-a1': WB_SID, 'data-a2': '工作台演示会话' },
    { value: '工作台演示会话' });
  await settle(calls);
  assert.equal(calls.filter((c) => c.startsWith('PATCH /api/kernel/sessions')).length, 0, '没改动就不该发 PATCH');
  assert.ok(!/会话已改名/.test(dom.state.html), '也不该说"已改名"（它没改）');
});

await t('改名失败：如实报错（含服务端原因），不假装成功', async () => {
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['PATCH /api/kernel/sessions/' + WB_SID]: {
        status: 500,
        body: { ok: false, error: { code: 'internal', message: '写库失败：磁盘只读' } },
      },
    }),
  });
  await clickAndAnswer(dom, sandbox,
    { 'data-act': 'wbRenameSession', 'data-a1': WB_SID, 'data-a2': '工作台演示会话' },
    { value: '改不动的名字' });
  await settle(calls);
  const html = dom.state.html;
  assert.ok(/重命名失败/.test(html), '失败必须直说：' + html.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(/磁盘只读/.test(html), '要把服务端给的原因带出来（只说"失败了"等于没报）');
  assert.ok(!/会话已改名/.test(html), '失败时不得出现成功回执');
});

await t('删除：先确认（写明真删口径与保留项）；确认后 DELETE，并按服务端回执播报级联数字', async () => {
  let deleted = false;
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['DELETE /api/kernel/sessions/' + WB_SID]: {
        status: 200,
        body: {
          deleted: true, id: WB_SID,
          cascaded: { events: 7, attachments: 1, artifacts: 2, session: 1 },
          bytesDeleted: 4096,
          kept: { usageRecords: '用量台账保留', upstream: '上游内核侧会话不在此删除' },
        },
        onCall() { deleted = true; },
      },
      ['GET /api/kernel/sessions']: {
        status: 200,
        get body() {
          return deleted ? { items: [], total: 0 } : {
            items: [{
              id: WB_SID, title: '工作台演示会话', cwd: '', kernelSessionId: 'up-1', eventCount: 3,
              createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:10:00Z',
            }],
            total: 1,
          };
        },
      },
    }),
  });

  const opened = await clickAndAnswer(dom, sandbox,
    { 'data-act': 'wbDeleteSession', 'data-a1': WB_SID, 'data-a2': '工作台演示会话' }, {});
  assert.ok(/删除「工作台演示会话」/.test(opened), '确认框要点名删的是哪一个');
  assert.ok(/这是真删，不可恢复/.test(opened), '必须说清是真删');
  assert.ok(/用量台账保留/.test(opened), '要写明什么留下 —— 否则用户没法判断后果');
  assert.ok(/上游内核侧的会话不在此删除/.test(opened), '上游边界也要写在确认框里');

  await settle(calls);
  assert.equal(calls.filter((c) => c === 'DELETE /api/kernel/sessions/' + WB_SID).length, 1, '应只发一次 DELETE');

  const html = dom.state.html;
  assert.ok(/会话已删除：事件 7 条、附件 1 个（字节 4096）、产物记录 2 条；用量台账保留。/.test(html),
    '回执数字要原样转述服务端的级联计数：' + html.replace(/\s+/g, ' ').slice(0, 500));
  // 0.21.9：列表空了之后**不再有"未分组"桶**接着 —— 树上是"这个工作区里还没有会话"
  // 那一行（工作区本身还在，这是它与"未分组"最本质的区别：工作区是真实存在的一行）。
  assert.ok(/还没有会话/.test(html), '删掉当前会话后工作区行下如实说"还没有会话"');
  assert.ok(!/未分组/.test(html), '不再有「未分组」桶去接住它（那个概念已删）');
  assert.ok(!/data-a1="ks_workbench_demo"/.test(html), '已删的会话不得残留在侧栏');
});

await t('没有 session:write 时不渲染改名/删除入口（入口只听服务端的 canManage，不听本地权限矩阵）', async () => {
  const perms = wbMemberPerms();
  perms.session = { read: true, write: false, execute: true };
  const { dom, sandbox, calls } = await openWorkbench({
    permissions: perms,
    // 服务端才是权威：它用与动作守卫**同一个判据**算出 canManage=false
    // （前端只有 `session:read` 时，真实响应里这一条也是 false）。
    // 这里刻意**手写**成 false 而不是靠本地权限矩阵推出 —— 钉住的正是
    // "前端不自己拼第二份规则"：真实响应说不能管，界面就不摆入口。
    overrides: wbOverrides({
      ['GET /api/kernel/sessions']: {
        status: 200,
        body: {
          items: [{
            id: WB_SID, title: '工作台演示会话', cwd: '', kernelSessionId: 'up-1', eventCount: 3,
            ownerUserId: 'u-other', isMine: false, canManage: false, manageNeed: 'full',
            // ⚠️ 0.21.12 修正：`workspaceId` 必填。树是
            //    `sessions.filter(s => s.workspaceId === ws.id)`（见 wbTreeHtml），
            //    而 0.21.9「未分组」桶整块删除之后**没有兜底容器**会接住无归属的会话 ——
            //    少了这个字段，这条会话在树上根本不渲染，于是下面
            //    `有读权限，会话仍应可见` 拿到的是"树上没有它"。
            //    服务端确实回显 workspaceId，夹具必须按真实形状给（缺了就是假的失败）。
            workspaceId: 'wsp_demo_full', presetId: 'standard',
            createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:10:00Z',
          }],
          total: 1,
        },
      },
    }),
  });
  const html = dom.state.html;
  assert.ok(/工作台演示会话/.test(html), '有读权限，会话仍应可见');
  assert.ok(/data-act="wbPickSession"/.test(html), '仍能点开查看');
  assert.ok(!/wbRenameSession|wbDeleteSession/.test(html), '没有写权限就不该有写入口');
  assert.ok(!calls.some((c) => /^(PATCH|DELETE) /.test(c)), '也不该发出写请求');
  // 导出只需要 session:read：只读用户仍应有导出入口 —— 而且要能在菜单里真的找到
  await sandbox.window.App.wbToggleRowMenu('session', WB_SID);
  const opened = dom.state.html;
  assert.ok(/data-act="wbExportSession"/.test(opened),
    '导出只需要 session:read：只读用户仍应有导出入口（菜单里）');
  assert.ok(!/data-act="wbRenameSession"|data-act="wbDeleteSession"/.test(opened),
    '没有管理权时菜单里也不摆改名/删除（点了必然 403 的入口是假入口）');
});

await t('流式进行中：会话菜单里的三个入口都禁用；本轮收尾后恢复可用', async () => {
  const { dom, sandbox, calls } = await openWorkbench();
  // 先把菜单摊开（0.21.1：入口在菜单里），再看流式期间那三个按钮的状态
  await sandbox.window.App.wbToggleRowMenu('session', WB_SID);
  dom.byId('wb-input').value = '工作台你好';
  const p = sandbox.window.App.wbSend();   // 不 await：先看"流已开始、尚未结束"这一刻的渲染
  const during = dom.state.html;
  assert.ok(/data-act="wbRenameSession"[^>]*disabled/.test(during), '流式进行中改名按钮应禁用');
  assert.ok(/data-act="wbDeleteSession"[^>]*disabled/.test(during), '流式进行中删除按钮应禁用');
  assert.ok(/data-act="wbExportSession"[^>]*disabled/.test(during),
    '流式进行中导出按钮应禁用 —— 本轮事件还没落库，此刻导出只能拿到半截转录');
  await p;
  await settle(calls);
  const after = dom.state.html;
  assert.ok(!/data-act="wbRenameSession"[^>]*disabled/.test(after), '回合结束后应恢复可用');
  assert.ok(!/data-act="wbDeleteSession"[^>]*disabled/.test(after), '同上');
  assert.ok(!/data-act="wbExportSession"[^>]*disabled/.test(after), '导出同理');
});

/* ── 工作台会话导出：转录 md / json（0.17.0）──────────────────────────
 *
 * 与服务端 `/export` 同一条路：导出的是**转录**（注入段剥出并注明），不是事件转储 ——
 * 后者是「治理 → 会话日志」log.zip 的职责。这里钉三件事：
 *   · 格式选择走应用内单选弹层（默认 md，取消＝什么都不做）；
 *   · 请求真的带上了所选 format（makeFetch 的 onCall 拿原始 URL —— 查表键是去 query 的）；
 *   · 回执如实播报条数与截断警告（20000 条上限这件事必须当场说，不能冒充完整）。
 */

section('工作台会话导出：转录 md / json（注入段剥出、截断如实标注）');

await t('导出：弹层列出两种格式并预选 md；确认后真调导出接口，回执播报真实条数', async () => {
  let exportUrl = null;
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['GET /api/kernel/sessions/' + WB_SID + '/export']: {
        status: 200,
        onCall: (opts, url) => { exportUrl = url; },
        body: {
          sessionId: WB_SID, title: '工作台演示会话', format: 'md',
          filename: '工作台演示会话.md', eventCount: 12, truncated: false,
          content: '# 工作台演示会话\n\n## 用户\n\n历史上的一个问题\n',
        },
      },
    }),
  });
  const opened = await clickAndAnswer(dom, sandbox,
    { 'data-act': 'wbExportSession', 'data-a1': WB_SID, 'data-a2': '工作台演示会话' }, {});
  assert.ok(/导出会话/.test(opened), '应弹出导出对话框');
  assert.ok(/Markdown（\.md）/.test(opened) && /JSON（\.json）/.test(opened), '两种格式都要列出');
  assert.ok(/checked/.test(opened), '默认要预选 md（不预选的话直接点导出会选不成）');
  await settle(calls);
  assert.ok(calls.includes('GET /api/kernel/sessions/' + WB_SID + '/export'), '导出应真的调导出接口');
  assert.ok(/format=md/.test(String(exportUrl)), '默认格式应为 md，实际：' + exportUrl);
  const html = dom.state.html;
  assert.ok(/已导出「工作台演示会话」：md，12 条事件/.test(html),
    '回执要带真实条数：' + html.replace(/\s+/g, ' ').slice(0, 400));
});

await t('导出：选 JSON → 请求就带 format=json；截断时如实警告并给出拿完整轨迹的去处', async () => {
  let exportUrl = null;
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['GET /api/kernel/sessions/' + WB_SID + '/export']: {
        status: 200,
        onCall: (opts, url) => { exportUrl = url; },
        body: {
          sessionId: WB_SID, title: '工作台演示会话', format: 'json',
          filename: '工作台演示会话.json', eventCount: 20000, truncated: true,
          content: { sessionId: WB_SID, messages: [{ role: 'user', text: '历史上的一个问题' }] },
        },
      },
    }),
  });
  await clickAndAnswer(dom, sandbox,
    { 'data-act': 'wbExportSession', 'data-a1': WB_SID, 'data-a2': '工作台演示会话' },
    { pick: [1] });   // 第 2 个选项 = JSON
  await settle(calls);
  assert.ok(/format=json/.test(String(exportUrl)), '选了 JSON 请求就应是 json，实际：' + exportUrl);
  const html = dom.state.html;
  assert.ok(/已达导出上限/.test(html), '截断必须当场说：不能让"前 20000 条"被当成全部');
  assert.ok(/治理 → 会话日志/.test(html), '并给出拿完整轨迹的去处（log.zip 那条路）');
});

await t('导出：取消＝什么都不做（不发请求，也没有"已导出"回执）', async () => {
  const { dom, sandbox, calls } = await openWorkbench();
  await clickAndAnswer(dom, sandbox,
    { 'data-act': 'wbExportSession', 'data-a1': WB_SID, 'data-a2': '工作台演示会话' },
    { cancel: true });
  await settle(calls);
  assert.equal(calls.filter((c) => c.endsWith('/export')).length, 0, '取消不该发导出请求');
  assert.ok(!/已导出/.test(dom.state.html), '也不该有成功回执');
});

await t('导出失败：如实报错（含服务端原因），不假装成功', async () => {
  const { dom, sandbox, calls } = await openWorkbench({
    overrides: wbOverrides({
      ['GET /api/kernel/sessions/' + WB_SID + '/export']: {
        status: 500,
        body: { ok: false, error: { code: 'internal', message: '读库失败：锁超时' } },
      },
    }),
  });
  await clickAndAnswer(dom, sandbox,
    { 'data-act': 'wbExportSession', 'data-a1': WB_SID, 'data-a2': '工作台演示会话' }, {});
  await settle(calls);
  const html = dom.state.html;
  assert.ok(/导出失败/.test(html), '失败必须直说：' + html.replace(/\s+/g, ' ').slice(0, 400));
  assert.ok(/锁超时/.test(html), '要把服务端给的原因带出来（只说"失败了"等于没报）');
  assert.ok(!/已导出/.test(html), '失败时不得出现成功回执');
});

/* ── 接口清单页：路由表 + OpenAPI 入口（P1-3）───────────────────── */

section('接口清单页：路由表数据 + OpenAPI 下载入口与诚实边界');

await t('接口清单页：渲染真实路由表，并给出 OpenAPI 下载入口 + 说明它由路由表生成', async () => {
  const { dom } = await openGovPage('#/routes');
  const html = dom.state.html;
  const r = routes['GET /api/system/routes'].body;
  assert.ok(r && r.routes && r.routes.length, '前置：录制期应有路由表');
  assert.ok(html.includes('路由表（' + r.routes.length + ' 条'), '应显示真实条数（不是写死的数字）');

  assert.ok(/OpenAPI 规格/.test(html), '应有 OpenAPI 面板');
  assert.ok(/\/api\/system\/openapi\.json/.test(html), '要有可点的规格地址（对接方唯一的入口）');
  assert.ok(/路由表生成/.test(html), '要说明规格是**从路由表生成**的 —— 这才是"不会漂移"的依据');
  assert.ok(/不是逐字段契约/.test(html),
    '必须写明"不是逐字段契约"：否则对接方会以为字段都被声明了，照着写代码然后踩空');
});

section('调度中心页：真实任务、规则人话、边界声明、执行体清单');

await t('调度页：渲染真实任务、规则人话说明，并把「不补跑 / UTC」写在界面上', async () => {
  const { dom } = await openGovPage('#/schedules');
  const html = dom.state.html;
  assert.ok(/调度中心/.test(html), '应能进入调度中心页');
  assert.ok(/新建任务/.test(html), '有 schedule:write 时应渲染新建表单');

  const job = routes['GET /api/schedule/jobs'].body.jobs[0];
  assert.ok(job, '前置：录制期应留下一条任务');
  assert.ok(html.includes(job.name), '应渲染真实任务名：' + job.name);
  assert.ok(html.includes('每 1 小时'), '规则要显示成人话，而不是只有 interval:3600000');
  assert.ok(html.includes('interval:3600000'), '原始规则也要保留（排障时要看得到）');

  // 这条边界必须落在页面上：少了它，"有调度器"会被读成"高可用调度"。
  assert.ok(/不补跑/.test(html), '必须写明"不补跑错过的任务"（否则会被当成 cron）：'
    + html.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(/UTC/.test(html), 'dailyAt 按 UTC 解释必须写在界面上');

  // 执行体清单：让"能配什么"有出口，而不是让运维去读代码
  assert.ok(/可用的执行体/.test(html), '应渲染执行体说明表');
  for (const k of routes['GET /api/schedule/jobs'].body.status.kinds) {
    assert.ok(html.includes(k), '执行体 ' + k + ' 应出现在清单里');
  }
});

await t('调度页动作：创建 / 立即执行 / 手动扫描 / 启停 / 删除都真的打到了接口', async () => {
  const ids = globalThis.__jobIds;
  const { dom, sandbox, calls } = await openGovPage('#/schedules');

  // 创建：读表单 → POST
  dom.byId('job-name').value = '动作探针任务';
  dom.byId('job-kind').value = 'audit.archive';
  dom.byId('job-schedule').value = 'interval:600000';
  await sandbox.window.App.createJob();
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/schedule/jobs'), '创建应真的 POST');
  assert.ok(/已创建任务/.test(dom.state.html), '创建后要有可见反馈');

  // 立即执行：要过确认弹层（它会真的干活，不是演练）
  const pr = sandbox.window.App.runJob(ids.main, '录制审计归档');
  await answer(sandbox, dom);
  await pr;
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/schedule/jobs/' + ids.main + '/run'), '立即执行应真的 POST');
  assert.ok(/执行结束：skipped/.test(dom.state.html),
    '要把服务端的执行结论（skipped）如实显示出来，而不是自己判断成没成');

  // 手动扫描
  await sandbox.window.App.tickNow();
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/schedule/tick'), '扫描应真的 POST');
  assert.ok(/调度扫描完成/.test(dom.state.html), '扫描后要显示"到期/执行/失败"三个数');

  // 启停
  await sandbox.window.App.toggleJob(ids.main, false);
  await settle(calls);
  assert.ok(calls.some((c) => c === 'PUT /api/schedule/jobs/' + ids.main), '启停应真的 PUT');

  // 删除
  const pj = sandbox.window.App.deleteJob(globalThis.__jobDeleteId, '录制待删任务');
  await answer(sandbox, dom);
  await pj;
  await settle(calls);
  assert.ok(calls.some((c) => c === 'DELETE /api/schedule/jobs/' + globalThis.__jobDeleteId), '删除应真的 DELETE');
  assert.ok(/已删除/.test(dom.state.html), '删除后要有可见反馈');
});

await t('调度页：行内编辑器按条目 id 预填现值（名称/执行体/规则/参数），App.saveJob 存在', async () => {
  const ids = globalThis.__jobIds;
  const { dom, sandbox } = await openGovPage('#/schedules');
  const html = dom.state.html;
  // 预填是这条编辑器的核心价值：改一个名字不该让人把规则和参数从别处抄一遍。
  assert.ok(new RegExp('id="je-' + ids.main + '-name"[^>]*value="录制审计归档"').test(html),
    '名称输入框要预填当前值，实际：' + html.replace(/\s+/g, ' ').slice(-600));
  assert.ok(new RegExp('id="je-' + ids.main + '-schedule"[^>]*value="interval:3600000"').test(html),
    '规则输入框要预填当前值');
  assert.ok(new RegExp('id="je-' + ids.main + '-params"[^>]*value="\\{\\}"').test(html),
    '参数输入框要预填当前参数（当前是 {}）');
  assert.ok(/<option value="audit\.archive" selected>/.test(html), '执行体下拉要选中当前值');
  assert.ok(/data-act="saveJob"/.test(html), '保存按钮要挂 saveJob');
  assert.ok(/清空 = 回到执行体内置默认/.test(html), '"清空 params 的含义"要写在编辑器里');
  assert.equal(typeof sandbox.window.App.saveJob, 'function', 'App.saveJob 必须存在（事件委托按名字找函数）');
});

await t('调度页动作：行内编辑真的 PUT 全字段（名称/执行体/规则/参数），并给可见反馈', async () => {
  const ids = globalThis.__jobIds;
  const putKey = 'PUT /api/schedule/jobs/' + ids.main;
  const putBodies = [];
  const overrides = {};
  // 在真实录到的响应上挂 onCall，把**请求体**录下来 —— 断言"发对了字段"，
  // 而不只是"发过请求"。
  overrides[putKey] = Object.assign({}, routes[putKey], {
    onCall: (opts) => putBodies.push(JSON.parse(opts.body || '{}')),
  });
  const { dom, sandbox, calls } = await openGovPage('#/schedules', overrides);

  // 在预填的现值上改四个字段。⚠️ DOM 垫片不会像浏览器那样把渲染 HTML 里的 value/selected
  // 回填到元素上（.value 初值一律是 ''），所以"下拉保持不动"必须显式设成它的预选值 ——
  // 浏览器里 <option value="audit.archive" selected> 读出来就是它（预选本身由上一个用例断言 HTML）。
  dom.byId('je-' + ids.main + '-name').value = '录制审计归档（改后）';
  dom.byId('je-' + ids.main + '-kind').value = 'audit.archive';
  dom.byId('je-' + ids.main + '-schedule').value = 'interval:7200000';
  dom.byId('je-' + ids.main + '-params').value = '{"retentionDays": 30}';
  await sandbox.window.App.saveJob(ids.main);
  await settle(calls);
  assert.ok(calls.some((c) => c === putKey), '保存应真的 PUT');
  assert.deepEqual(putBodies, [{
    name: '录制审计归档（改后）', kind: 'audit.archive',
    schedule: 'interval:7200000', params: { retentionDays: 30 },
  }], '提交的应是编辑器四个字段的现值，实际：' + JSON.stringify(putBodies));
  assert.ok(/已保存「录制审计归档（改后）」/.test(dom.state.html), '保存后要有可见反馈，实际：'
    + dom.state.html.replace(/\s+/g, ' ').slice(0, 300));
});

await t('调度页动作：坏参数 JSON / 空名当场拦住 —— 不发请求、错误可见', async () => {
  const ids = globalThis.__jobIds;
  const { dom, sandbox, calls } = await openGovPage('#/schedules');
  const before = calls.length;

  // 坏 JSON：服务端报的是"params 必须是一个对象"—— 对着一串手滑打坏的文字帮不上忙，
  // 必须在浏览器里就拦住，并说清是 JSON 语法问题。
  // 垫片不回填 value，先把名称补成当前值（浏览器里它是预填好的），否则空名检查先拦住，
  // 测到的就不是 JSON 分支了。
  dom.byId('je-' + ids.main + '-name').value = '录制审计归档';
  dom.byId('je-' + ids.main + '-params').value = '{oops';
  await sandbox.window.App.saveJob(ids.main);
  await settle(calls);
  assert.ok(!calls.slice(before).some((c) => c.startsWith('PUT /api/schedule/jobs/')),
    '坏 JSON 不该发请求');
  assert.ok(/参数不是合法 JSON/.test(dom.state.html), '要给出可见错误，而不是静默无反应');

  // 空名：同一纪律（服务端也会拒，但没必要花一次往返）
  dom.byId('je-' + ids.main + '-name').value = '   ';
  await sandbox.window.App.saveJob(ids.main);
  await settle(calls);
  assert.ok(!calls.slice(before).some((c) => c.startsWith('PUT /api/schedule/jobs/')), '空名不该发请求');
  assert.ok(/任务名不能为空/.test(dom.state.html), '空名要有可见错误');
});

await t('调度页权限收敛：无 schedule:write 时看得到任务列表，却没有新建表单与行内编辑器', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  assert.ok(perms.schedule, '前置：owner 的权限矩阵应显式含 schedule 资源（否则本用例测不到东西）');
  perms.schedule.read = true;
  perms.schedule.write = false;
  const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: perms });
  await sandbox.window.App.login();
  await settle(calls);
  dom.window.location.hash = '#/schedules';
  dom.state.listeners['window:hashchange']();
  const html = dom.state.html;
  assert.ok(/调度中心/.test(html), '有 read 就该能进页面');
  assert.ok(html.includes(routes['GET /api/schedule/jobs'].body.jobs[0].name), '任务列表照常可见');
  assert.ok(!/data-act="saveJob"/.test(html), '无 write 不该有行内编辑器的保存按钮');
  assert.ok(!/data-act="toggleJob"/.test(html) && !/data-act="runJob"/.test(html), '无 write 也不该有执行/启停按钮');
  assert.ok(!/新建任务/.test(html), '无 write 不渲染新建表单');
});

section('通知渠道页：URL 只回显 host、试发结论如实、事件订阅可读');

await t('通知页：渲染真实渠道与订阅事件，且**整页不出现 token**', async () => {
  const { dom } = await openGovPage('#/notify');
  const html = dom.state.html;
  assert.ok(/通知渠道/.test(html), '应能进入通知渠道页');
  assert.ok(/登记渠道/.test(html), '有 notify:write 时应渲染登记表单');

  const c = routes['GET /api/notify/channels'].body.channels[0];
  assert.ok(c, '前置：录制期应留下一条渠道');
  assert.ok(html.includes(c.name), '应渲染真实渠道名：' + c.name);
  assert.ok(html.includes(c.host), '应显示 host（运维要认出这条是发给谁的）');
  for (const e of c.events) assert.ok(html.includes(e), '订阅事件 ' + e + ' 应显示出来');

  // 页面上绝不能泄漏 token —— 它等价于一个密钥
  assert.ok(!/FE-SUPER-SECRET-TOKEN/.test(html), '页面不得出现 webhook token');
  assert.ok(!/access_token/.test(html), '连 query 都不能出现');
  assert.ok(/加密存放/.test(html), '要写明"URL 加密存放"，而不是让人以为平台藏了什么');
  assert.ok(/SSRF|回环/.test(html), '要写明哪些目标会被拒（回环/云元数据），否则运维会以为是坏了');
});

await t('通知页动作：登记 / 试发 / 启停 / 删除都真的打到了接口', async () => {
  const ids = globalThis.__chanIds;
  const { dom, sandbox, calls } = await openGovPage('#/notify');

  // 登记：读表单 + 勾选事件 → POST
  dom.byId('nc-name').value = '动作探针群';
  dom.byId('nc-url').value = 'http://10.0.0.9/hook?access_token=ANOTHER-SECRET';
  // 事件复选框的 id 把事件名里的点净化为 `-`：带点 id 在真浏览器里 `querySelector` 读不到
  // （`#nc-e-quota.blocked` 被解析成 id+class），0.18.0 真机复核抓到，垫片按字面匹配曾盖住它。
  dom.byId('nc-e-quota-blocked').checked = true;
  await sandbox.window.App.createChannel();
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/notify/channels'), '登记应真的 POST');
  assert.ok(/已登记渠道/.test(dom.state.html), '登记后要有可见反馈');
  assert.ok(/只回显 host/.test(dom.state.html), '反馈里要说明"URL 已加密、只回显 host"');

  // 试发：结论在 result 里，不是 HTTP 状态码
  await sandbox.window.App.testChannel(ids.main, '录制运维群');
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/notify/channels/' + ids.main + '/test'), '试发应真的 POST');
  assert.ok(/试发成功/.test(dom.state.html), '桩服务器回了 200，应显示试发成功');

  // 启停（url 留空 = 不改动）
  await sandbox.window.App.toggleChannel(ids.main, false);
  await settle(calls);
  assert.ok(calls.some((c) => c === 'PUT /api/notify/channels/' + ids.main), '启停应真的 PUT');

  // 删除
  const pc = sandbox.window.App.deleteChannel(globalThis.__chanDeleteId, '录制待删渠道');
  await answer(sandbox, dom);
  await pc;
  await settle(calls);
  assert.ok(calls.some((c) => c === 'DELETE /api/notify/channels/' + globalThis.__chanDeleteId), '删除应真的 DELETE');
  assert.ok(/已删除/.test(dom.state.html), '删除后要有可见反馈');
});

await t('通知页：行内编辑器按条目预填现值，URL 刻意留空，复选框 id 不带点', async () => {
  const ids = globalThis.__chanIds;
  const { dom, sandbox } = await openGovPage('#/notify');
  const html = dom.state.html;
  const c = routes['GET /api/notify/channels'].body.channels[0];
  // 预填是编辑器的核心价值：改名时不该让人把订阅列表凭记忆重新勾一遍。
  assert.ok(new RegExp('id="ce-' + ids.main + '-name"[^>]*value="' + c.name + '"').test(html),
    '名称输入框要预填当前渠道名，实际：' + html.replace(/\s+/g, ' ').slice(-600));
  // URL **刻意不预填**：服务端不回显完整 URL（常内嵌 token），提交框里永远不该出现它。
  assert.ok(new RegExp('id="ce-' + ids.main + '-url"[^>]*placeholder="新 Webhook URL（留空 = 不改动）"').test(html),
    'URL 框要写明"留空 = 不改动"');
  assert.ok(!/id="ce-[^"]*-url"[^>]*value=/.test(html), 'URL 框不得预填任何值（服务端也不回显）');
  assert.ok(!/FE-SUPER-SECRET-TOKEN/.test(html), '编辑器不得泄漏 token');
  // 复选框 id 净化：带点 id 在真浏览器里 querySelector 读不到（`#nc-e-quota.blocked`
  // 被解析成 id+class），上面动作用例有详细注释。
  assert.ok(html.includes('id="ce-' + ids.main + '-quota-blocked"'), '订阅事件复选框 id 应净化（quota.blocked → quota-blocked）');
  assert.ok(html.includes('id="ce-' + ids.main + '-backup-failed"'), '每个可订阅事件都应有一个复选框');
  assert.ok(new RegExp('id="ce-' + ids.main + '-quota-blocked"[^>]*checked').test(html), '当前已订阅的事件要预勾选');
  assert.ok(new RegExp('id="ce-' + ids.main + '-audit-anchor"[^>]*checked').test(html), 'audit.anchor 也应预勾选');
  assert.ok(!new RegExp('id="ce-' + ids.main + '-backup-failed"[^>]*checked').test(html), '未订阅的事件不该预勾选');
  assert.ok(!/id="ce-[^"]*\./.test(html), '编辑器里不得出现带点的 id（querySelector 读不到）');
  assert.ok(/id="nc-e-quota-blocked"/.test(html), '登记表单的复选框 id 同样净化');
  assert.ok(/整体替换/.test(html), '"保存按勾选整体替换订阅列表"要写出来（否则用户以为只增不减）');
  assert.equal(typeof sandbox.window.App.saveChannel, 'function', 'App.saveChannel 必须存在（事件委托按名字找函数）');
});

await t('通知页动作：行内编辑真的 PUT（改名 + 轮换 URL + 订阅整体替换），并有可见反馈', async () => {
  const ids = globalThis.__chanIds;
  const putKey = 'PUT /api/notify/channels/' + ids.main;
  const putBodies = [];
  const overrides = {};
  // 同路径的 PUT 在回放里默认解析到"启停"那次录制；这里换成编辑专用响应（#edit），
  // 并在真实录到的响应上挂 onCall，把**请求体**录下来断言"发对了字段"。
  overrides[putKey] = Object.assign({}, routes[putKey + '#edit'], {
    onCall: (opts) => putBodies.push(JSON.parse(opts.body || '{}')),
  });
  const { dom, sandbox, calls } = await openGovPage('#/notify', overrides);

  // ⚠️ 垫片不会把渲染 HTML 里的 checked/value 回填到元素上（初值一律 ''/false），
  // "保持不动"与"改这一项"都必须显式设值 —— 浏览器里它们由预填与 checked 属性生效
  //（预填本身由上一个用例断言 HTML）。
  dom.byId('ce-' + ids.main + '-name').value = '录制运维群（改后）';
  dom.byId('ce-' + ids.main + '-url').value = 'http://10.0.0.7/rotated-hook';
  dom.byId('ce-' + ids.main + '-quota-blocked').checked = false;
  dom.byId('ce-' + ids.main + '-audit-anchor').checked = true;
  dom.byId('ce-' + ids.main + '-backup-failed').checked = true;
  await sandbox.window.App.saveChannel(ids.main);
  await settle(calls);
  assert.ok(calls.some((c) => c === putKey), '保存应真的 PUT');
  assert.deepEqual(putBodies, [{
    name: '录制运维群（改后）', events: ['backup.failed', 'audit.anchor'], url: 'http://10.0.0.7/rotated-hook',
  }], '提交的应是编辑器现值：名字 + 整体替换的订阅 + 填了才带的 url，实际：' + JSON.stringify(putBodies));
  assert.ok(/已保存渠道「录制运维群（改后）」/.test(dom.state.html), '保存后要有可见反馈，实际：'
    + dom.state.html.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(/URL 已更新/.test(dom.state.html), '换了 URL 要说清"已更新、仍只回显 host"');
});

await t('通知页动作：URL 留空 = 不改动（请求体不带 url 键）；空名当场拦住不发请求', async () => {
  const ids = globalThis.__chanIds;
  const putKey = 'PUT /api/notify/channels/' + ids.main;
  const putBodies = [];
  const overrides = {};
  overrides[putKey] = Object.assign({}, routes[putKey + '#edit'], {
    onCall: (opts) => putBodies.push(JSON.parse(opts.body || '{}')),
  });
  const { dom, sandbox, calls } = await openGovPage('#/notify', overrides);

  // URL 留空：服务端不回显完整 URL（常内嵌 token），表单不可能把它填回来 ——
  // 提交空串等于把密钥清掉，那是"保存即破坏"。不填就必须**不提交这个键**。
  dom.byId('ce-' + ids.main + '-name').value = '录制运维群';
  dom.byId('ce-' + ids.main + '-quota-blocked').checked = true;
  await sandbox.window.App.saveChannel(ids.main);
  await settle(calls);
  assert.equal(putBodies.length, 1, '应发一次 PUT');
  assert.ok(!('url' in putBodies[0]), 'URL 留空时请求体里不该有 url 键（空串 = 清密钥），实际：' + JSON.stringify(putBodies[0]));
  assert.deepEqual(putBodies[0].events, ['quota.blocked'], '只勾了 quota.blocked，实际：' + JSON.stringify(putBodies[0]));
  assert.ok(/URL 未改动/.test(dom.state.html), '反馈要说明"URL 未改动"');

  // 空名：服务端也会拒，但没必要花一次往返；本地拦住还能给出对着输入框的上下文。
  const before = calls.length;
  dom.byId('ce-' + ids.main + '-name').value = '   ';
  await sandbox.window.App.saveChannel(ids.main);
  await settle(calls);
  assert.ok(!calls.slice(before).some((c) => c === putKey), '空名不该发请求');
  assert.ok(/渠道名不能为空/.test(dom.state.html), '空名要有可见错误');
});

await t('通知页权限收敛：无 notify:write 时渠道列表照常可见，但没有登记表单与行内编辑器', async () => {
  const perms = JSON.parse(JSON.stringify(meBody.permissions));
  assert.ok(perms.notify, '前置：owner 的权限矩阵应显式含 notify 资源（否则本用例测不到东西）');
  perms.notify.read = true;
  perms.notify.write = false;
  const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: perms });
  await sandbox.window.App.login();
  await settle(calls);
  dom.window.location.hash = '#/notify';
  dom.state.listeners['window:hashchange']();
  const html = dom.state.html;
  assert.ok(/通知渠道/.test(html), '有 read 就该能进页面');
  assert.ok(html.includes(routes['GET /api/notify/channels'].body.channels[0].name), '渠道列表照常可见');
  assert.ok(!/data-act="saveChannel"/.test(html), '无 write 不该有行内编辑器的保存按钮');
  assert.ok(!/data-act="testChannel"/.test(html) && !/data-act="toggleChannel"/.test(html), '无 write 也不该有试发/启停按钮');
  assert.ok(!/登记渠道/.test(html), '无 write 不渲染登记表单');
});

await t('通知页：失败队列**可见**（待重投条数 + 上限 + 语义），重投动作真的打到接口', async () => {
  // 这条盯的是一个**产品判断**：队列必须出现在页面上。后台默默重投只是把"告警丢了"
  // 换成"告警丢了但没人知道" —— 那比不做更糟。"还欠着几条"是运维要看的那个数。
  const { dom, sandbox, calls } = await openGovPage('#/notify');
  const html = dom.state.html;
  const dl = routes['GET /api/notify/deliveries'].body;

  assert.ok(/投递失败队列/.test(html), '队列面板必须渲染出来');
  assert.ok(/待重投/.test(html), '要显示"待重投"这个状态');
  assert.ok(html.includes(String(dl.queue.pending)), '要显示待重投条数 —— 这就是运维要看的那个数');
  assert.ok(/at-least-once/.test(html), '投递语义要出现在页面上，而不是只写在文档里');
  assert.ok(/X-STI-Delivery-Id/.test(html), '去重头也要写出来 —— 接收方要据此去重');

  const row = (dl.deliveries || []).find((d) => d.status !== 'delivered');
  assert.ok(row, '前置：录制期应留下一条待处理记录');
  assert.ok(html.includes(row.channelName), '应显示渠道名（运维要认出这是发给谁的）');
  assert.ok(html.includes(row.attempts + ' / ' + row.maxAttempts),
    '"已重投 X / 上限"要显示出来，否则运维算不出"还剩几次"');
  assert.ok(html.includes('立即重投'), '有 notify:write 时应给出重投按钮');

  await sandbox.window.App.redeliver(row.id);
  await settle(calls);
  assert.ok(calls.some((c) => c === 'POST /api/notify/deliveries/' + row.id + '/redeliver'),
    '重投应真的 POST');
  assert.ok(/重投仍未成功/.test(dom.state.html),
    '投递没成功不是接口失败：结论在 result 里，页面要如实说"仍未成功"');
});

await t('权限收敛：无 schedule:read / notify:read 时侧栏无入口，也不请求这两个接口', async () => {
  for (const [res, hash, pathPart] of [['schedule', '#/schedules', '/api/schedule'], ['notify', '#/notify', '/api/notify']]) {
    const perms = JSON.parse(JSON.stringify(meBody.permissions));
    assert.ok(perms[res], '前置：owner 的权限矩阵应显式含 ' + res + ' 资源（否则本用例测不到东西）');
    perms[res] = { read: false };
    const { dom, sandbox, calls } = await runApp({ needsSetup: false, permissions: perms });
    await sandbox.window.App.login();
    await settle(calls);
    assert.ok(!dom.state.html.includes(hash), '无 ' + res + ':read 不应出现 ' + hash + ' 入口');
    assert.ok(!calls.some((c) => c.includes(pathPart)),
      '无 ' + res + ':read 时连请求都不该发（否则每次登录都留一条注定 403 的审计）');
  }
});

/* ── 会话日志（0.18.0）：log.zip 的页面入口（审查缺口 C5）────────── */

await t('会话日志页：渲染真实会话行与下载入口，ZIP 内容与两条边界写在点击之前', async () => {
  const { dom, sandbox } = await openGovPage('#/sessionlogs');
  const html = dom.state.html;
  assert.ok(/data-nav="#\/sessionlogs"/.test(html), '侧栏应有会话日志入口');
  assert.ok(/这个 ZIP 里有什么/.test(html), 'ZIP 内容清单面板要渲染');
  // 四个条目名必须在**点击之前**就能看到 —— 包是二进制、页面不解包预览，
  // 页面上不写清里面有什么，用户只能"下完再说"。
  for (const f of ['meta.json', 'session.json', 'events.jsonl', 'artifacts.json']) {
    assert.ok(html.includes(f), 'ZIP 条目 ' + f + ' 要写在页面上');
  }
  assert.ok(/快照不是备份/.test(html), '"快照不是备份"的边界要在点击前可见');
  assert.ok(/记一条审计/.test(html) && /governance\.sessionlog\.export/.test(html),
    '"下载会记审计"（含审计动作名）要在点击前可见');

  // 下载按钮必须挂在**真实会话 id** 上（data-act 按名字找函数、data-a1 传参）——
  // 这两处任一处写错，症状都是"点了没反应"，而页面看起来完全正常。
  const m = html.match(/data-act="downloadSessionLog" data-a1="([^"]+)"/);
  assert.ok(m, '应有下载按钮（data-act="downloadSessionLog"）');
  assert.equal(m[1], SESSION_ID_FOR_LOG, 'data-a1 应是补录清单第一行的会话 id');
  assert.ok(/下载 log\.zip/.test(html), '按钮文案要写清下的是什么');
  assert.equal(typeof sandbox.window.App.downloadSessionLog, 'function', 'App.downloadSessionLog 必须存在（委托按名字找）');
});

await t('会话日志下载：经事件委托真调 log.zip，回执报真实字节数并说清快照与审计', async () => {
  const { dom, calls } = await openGovPage('#/sessionlogs');
  const sid = SESSION_ID_FOR_LOG;
  const key = 'GET /api/governance/sessions/' + encodeURIComponent(sid) + '/log.zip';
  assert.ok(routes[key] && routes[key]._b64, '前置：录制期应存下 log.zip 的原始字节');
  const zipBytes = Buffer.from(routes[key]._b64, 'base64').length;

  // 走真实的委托链路（不是直接调 App 方法）：这才能证明按钮上的属性与真实方法对得上。
  dom.state.listeners['document:click']({
    target: fakeEl({ 'data-act': 'downloadSessionLog', 'data-a1': sid, 'data-a2': '回归会话' }),
    preventDefault() {},
  });
  await settle(calls);

  assert.ok(calls.includes(key), '下载应真的 GET log.zip');
  const html = dom.state.html;
  assert.ok(/已下载/.test(html), '要有可见回执，实际：' + html.replace(/\s+/g, ' ').slice(0, 300));
  // 字节数必须来自**录到的真 ZIP**（回放时 blob 走的是 saveRaw 存下的原始字节）
  assert.ok(html.includes('已下载「回归会话」的会话日志 ZIP（' + zipBytes.toLocaleString('en-US') + ' 字节）'),
    '回执要报真实字节数');
  assert.ok(/——快照不是备份：/.test(html), '回执要复述"快照不是备份"（用户不用回页头再找一遍）');
  assert.ok(/此次导出已在服务端记审计/.test(html), '这次下载会在服务端留审计 —— 说明要在回执里兑现');
});

await t('会话日志下载失败：如实报错（含服务端原因），不给成功回执', async () => {
  const sid = SESSION_ID_FOR_LOG;
  const key = 'GET /api/governance/sessions/' + encodeURIComponent(sid) + '/log.zip';
  const overrides = {};
  overrides[key] = { status: 500, body: { ok: false, error: { code: 'zip_failed', message: '导出失败：磁盘写入错误' } } };
  const { dom, calls } = await openGovPage('#/sessionlogs', overrides);
  const before = calls.length;
  dom.state.listeners['document:click']({
    target: fakeEl({ 'data-act': 'downloadSessionLog', 'data-a1': sid }),
    preventDefault() {},
  });
  await settle(calls);
  assert.ok(calls.slice(before).includes(key), '请求应发出（失败要如实说，而不是悄悄吞掉）');
  const html = dom.state.html;
  assert.ok(/导出失败：磁盘写入错误/.test(html), '服务端给的原因要如实呈现，实际：'
    + html.replace(/\s+/g, ' ').slice(0, 300));
  assert.ok(!/已下载/.test(html), '失败不得给成功回执');
});

await t('会话日志权限收敛：无 artifact:read 侧栏无入口、直链回落；有 artifact 无 session 时如实说明差什么', async () => {
  // ① 无 artifact:read —— 页闸门关了：入口消失，手敲 hash 回落默认页
  const p1 = JSON.parse(JSON.stringify(meBody.permissions));
  assert.ok(p1.artifact, '前置：owner 的权限矩阵应显式含 artifact 资源（否则本用例测不到东西）');
  p1.artifact = { read: false };
  const ctx1 = await runApp({ needsSetup: false, permissions: p1 });
  await ctx1.sandbox.window.App.login();
  await settle(ctx1.calls);
  assert.ok(!/data-nav="#\/sessionlogs"/.test(ctx1.dom.state.html), '无 artifact:read 不应出现会话日志入口');
  ctx1.dom.window.location.hash = '#/sessionlogs';
  ctx1.dom.state.listeners['window:hashchange']();
  assert.ok(!/这个 ZIP 里有什么/.test(ctx1.dom.state.html), '手敲 hash 不得渲染会话日志页内容');
  // 0.21.2 起工作台是全屏视图（无页标题）——"回落到默认页"的判据是输入卡在
  //
  // ⚠️ 0.21.12 修正：这里必须**先等异步收敛**。落地页是工作台时，`render()` 里那句
  //    `App.wbEnsureLoaded()` 是惰性的（见 90-start.js）：它当场返回、数据稍后才到，
  //    而 `#wb-input` 只在 `State.wb.ready` 置位后才画得出来 —— 置位之前是 `wb-boot` 加载态。
  //    上面那次 `hashchange()` 只跑完了同步的 `render()`，加载链还没跑完，
  //    所以旧写法拿到的是**加载态**、判成"没回落到默认页"（假红）。
  await settle(ctx1.calls);
  assert.ok(/id="wb-input"/.test(ctx1.dom.state.html), '应回落到默认页（工作台，全屏视图）');

  // ② 有 artifact:read、无 session:read —— 页面在，但会话清单列不出来。
  //    这是**权限差**而不是失败：页面必须如实说清差的是 session:read，
  //    而不是给一个含糊的"读不到"，更不是假装页面坏了。
  const p2 = JSON.parse(JSON.stringify(meBody.permissions));
  assert.ok(p2.session, '前置：owner 的权限矩阵应显式含 session 资源');
  p2.session = { read: false };
  const ctx2 = await runApp({ needsSetup: false, permissions: p2 });
  await ctx2.sandbox.window.App.login();
  await settle(ctx2.calls);
  ctx2.dom.window.location.hash = '#/sessionlogs';
  ctx2.dom.state.listeners['window:hashchange']();
  const html2 = ctx2.dom.state.html;
  assert.ok(/data-nav="#\/sessionlogs"/.test(html2), '有 artifact:read 就应出现入口');
  assert.ok(/这个 ZIP 里有什么/.test(html2), '页面本身要能进 —— 下载只需要 artifact:read（有）');
  assert.ok(/你当前没有/.test(html2) && /session:read/.test(html2), '要如实说清差的权限是 session:read');
  assert.ok(!/下载 log\.zip/.test(html2), '列不出会话时不该有下载按钮');
  assert.ok(!/本页渲染失败/.test(html2), '这是权限差，不是渲染失败');
});

/* ── 管理闭环（0.16.0）："只能看"的功能补上界面出口 ──────────────── */

await t('能力页：MCP 登记表单渲染齐全；App.registerMcp / editMcpConfig 存在', async () => {
  const { dom, sandbox } = await openGovPage('#/capabilities');
  const html = dom.state.html;
  for (const id of ['mcp-name', 'mcp-transport', 'mcp-enabled', 'mcp-config']) {
    assert.ok(html.includes('id="' + id + '"'), 'MCP 登记表单缺输入项 ' + id);
  }
  assert.ok(/data-act="registerMcp"/.test(html), '保存按钮要挂 registerMcp');
  assert.ok(/value="stdio"/.test(html) && /value="sse"/.test(html) && /value="http"/.test(html),
    '传输方式下拉要有 stdio / sse / http 三选');
  assert.ok(/data-act="editMcpConfig"/.test(html), '已登记服务行内要有改配置入口');
  assert.ok(/保存后无法回显/.test(dom.state.html + ''), '覆盖式保存的提示应在表单附近');
  assert.equal(typeof sandbox.window.App.registerMcp, 'function', 'App.registerMcp 必须存在（跨片解析）');
  assert.equal(typeof sandbox.window.App.editMcpConfig, 'function');
});

await t('账号页：删除入口渲染（user:delete）；App.deleteUser 存在', async () => {
  const { dom, sandbox } = await openGovPage('#/users');
  assert.ok(/data-act="deleteUser"/.test(dom.state.html), 'owner 应看到删除按钮');
  assert.equal(typeof sandbox.window.App.deleteUser, 'function');
});

await t('模型页：行内编辑器渲染并写明"用途不可改"；App.updateModel 存在', async () => {
  const ids = globalThis.__modelIds;
  const { dom, sandbox } = await openGovPage('#/models');
  const html = dom.state.html;
  assert.ok(html.includes('id="me-' + ids.chat + '-name"'), '编辑器输入框要按条目 id 生成');
  assert.ok(/data-act="updateModel"/.test(html), '保存按钮要挂 updateModel');
  assert.ok(/不可改 —— 改用途会让/.test(html), '"用途不可改"的边界要写在编辑器里');
  assert.equal(typeof sandbox.window.App.updateModel, 'function');
});

await t('配额页：行内编辑器渲染（上限/模式/启用）并写明身份字段不可改；App.updateQuota 存在', async () => {
  const { dom, sandbox } = await openGovPage('#/quotas');
  const html = dom.state.html;
  assert.ok(/id="qe-/.test(html), '配额行要有行内编辑器（录制期已建规则，缺行说明录制/回放断了）');
  assert.ok(/data-act="updateQuota"/.test(html), '保存按钮要挂 updateQuota');
  assert.ok(/不能在此改/.test(html), '"身份字段不可改"的边界要写在编辑器里');
  assert.equal(typeof sandbox.window.App.updateQuota, 'function');
});

await t('可见性治理页：行内"切换判定"入口渲染；App.toggleBinding 存在', async () => {
  const { dom, sandbox } = await openGovPage('#/capPolicies');
  const html = dom.state.html;
  assert.ok(/data-act="toggleBinding"/.test(html), '行内要有切换判定按钮');
  assert.ok(/改为放行|改为拦截/.test(html), '按钮文案要说清切到哪边');
  assert.equal(typeof sandbox.window.App.toggleBinding, 'function');
});

await t('平台设置页：参数分组渲染、来源徽标在场、重启提示在场；App.loadSettings / saveSettings 存在', async () => {
  const { dom, sandbox } = await openGovPage('#/settings');
  const html = dom.state.html;
  for (const id of ['st-host', 'st-port', 'st-sessionTtlHours', 'st-trustProxy', 'st-chunkMaxChars', 'st-prefilterVector']) {
    assert.ok(html.includes('id="' + id + '"'), '设置页缺输入项 ' + id);
  }
  assert.ok(/data-act="saveSettings"/.test(html), '保存按钮要挂 saveSettings');
  assert.ok(/环境变量锁定|config\.json|默认值/.test(html), '来源徽标要渲染（否则"改了没生效"无从对账）');
  assert.ok(/重启/.test(html), '必须写明需要重启才生效');
  assert.ok(/凭据托管/.test(html), '密钥不在此页的说法要指向正确去处');
  assert.equal(typeof sandbox.window.App.loadSettings, 'function');
  assert.equal(typeof sandbox.window.App.saveSettings, 'function');
});

/* ── 收尾 ──────────────────────────────────────────────────────── */

await svc.close();

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
console.log('录制接口 ' + recorded.length + ' 条｜用例 ' + total + ' 个｜失败 ' + fails + ' 个');
console.log('DONE fails=' + fails);
process.exitCode = fails ? 1 : 0;
