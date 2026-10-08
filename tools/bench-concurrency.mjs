/**
 * 并发与长稳基准 —— 回答验收标准里那个此前**一直是空的**数字：「能扛多少并发用户」。
 *
 * 为什么需要（docs/assessment-0.11.0.md §B11）：
 *   `feasibility.md` 自己要求「单进程的写入吞吐上限要在文档里给出**实测数字**（不是「很快」）」；
 *   而此前全项目只有 `bench-search.mjs` 的**串行**检索延迟 —— 那不是并发吞吐。
 *   现在有了它，任何一个数字都能被重跑复现，也能看出回归。
 *
 * 它测什么：**真实的 HTTP 服务**（自建临时数据目录 + `listen(0)` 随机端口）在 N 路并发下的
 *   吞吐 / 延迟分位（P50/P95/P99）/ 错误率 / 内存曲线 / 事件循环滞后，外加一条**正确性**断言
 *   （并发后逐条核对"提交了多少、库里就有多少"，防"快是因为丢了写"）。
 *
 * ── 诚实边界（**必须原样引用到文档里**，否则这些数字会被当成它们证明不了的东西）────
 *   1. **内核是 测试替身**：不调真实模型。所以"回合"耗时里**没有模型时间** —— 结论只适用于
 *      「平台自身的开销」，**不能**外推成"端到端对话延迟"。后者取决于你接的模型服务商。
 *   2. **客户端与服务器同进程同机**：互相争 CPU。对"客户端在另一台机"的生产场景
 *      **偏悲观**；同时又因共享页缓存与同一时钟**偏乐观**。两头都得说，别只挑一头。
 *   3. **SQLite 是单写者**（WAL 只是"读不阻塞写"）。所有写请求最终排在**同一把写锁**上，
 *      所以"写并发"这个说法本身要打引号：它测的是**排队 + 调度**的开销，
 *      **不是**"数据库能并行写 N 个"。这也是"单机单进程"这条天花板的直接来源。
 *   4. **磁盘是本机的**（WAL + `synchronous=NORMAL`）。换 SSD / HDD / 网络盘，数字会变。
 *   5. **本基准把 IP 限流放到极大**（`STI_RATE_LIMIT=100000`）以免它掩盖服务能力。
 *      ⚠️ 反过来说：**默认 600 次/分钟/IP 才是真实业务最先撞上的那道墙** ——
 *      部署在反向代理后面时，若所有用户共用一个出口 IP，会远早于本基准的数字被限流。
 *      （登录另有 30 次/分钟/IP 的独立阈值。）
 *   6. **这是一台机的数字，不是集群的**：单进程没有分布式锁、并发配额是进程内存
 *      （`schedule/service.mjs` 与 `deploy.md` 都自己写明）。所以它同时就是**上线的天花板**。
 *
 * 用法：
 *   node tools/bench-concurrency.mjs                        # 阶梯 1/4/8/16/32/64 路，每档 8 s
 *   node tools/bench-concurrency.mjs --levels=8,32,128 --seconds=20
 *   node tools/bench-concurrency.mjs --repeat=3             # 每档重复 3 轮，报 min/中位/max（抑制单次抖动）
 *   node tools/bench-concurrency.mjs --seed-docs=250        # 语料规模（每篇约 200 段 → 实测块数会打印出来）
 *   node tools/bench-concurrency.mjs --soak=30m             # 长稳：固定并发跑指定时长，看漂移
 *   node tools/bench-concurrency.mjs --open-rates=20,60,120,240 --open-seconds=20
 *                                                           # 开环定速：找"从哪个速率开始崩"（拐点）
 *   node tools/bench-concurrency.mjs --open-rates=15,30,60,120 --open-sender=process
 *                                                           # ⬆ **要拐点就用这个**：
 *                                                           #   发包端另起一个进程（另一个事件循环）
 *   node tools/bench-concurrency.mjs --scenarios=search,turn,mixed
 *   node tools/bench-concurrency.mjs --json                 # 末行输出 JSON，便于写进文档
 *
 * 三种压法的分工（别混用，`--soak` 与 `--open-rates` 同时给会直接报错退出）：
 *   · **闭环阶梯**（默认）：给 N 个同时在用的人，「每人要等多久」→ 容量与延迟分位
 *   · **长稳**（`--soak`）：固定并发跑很久 → 内存/延迟是否**随时间漂移**（泄漏、退化）
 *   · **开环定速**（`--open-rates`）：固定速率不等响应 → **从哪个速率开始堆积到崩**（拐点）
 *
 * ⚠️ **开环定速必须用 `--open-sender=process` 才问得出拐点**。默认的 `inproc` 与服务器
 *    共用一个事件循环：服务端一卡，发包节拍也被拖慢，于是"实际发出 < 目标"分不清是
 *    "服务端撑不住"还是"客户端发不出"（实测目标 30 req/s 只发得出 17.6）。
 *    `process` 仍与服务器**同机**，所以它解决的是"发包节拍被拖慢"，**不是**"争 CPU" —— 后者要另一台机器。
 *
 * ⚠️ **采样窗口与重复次数不是可选项**：每档 `--seconds` 太短（如 3~8 s）时，单次结果会有
 *    几十个百分点的抖动，曲线会**非单调**（实测 16 路吞吐可能低于 8 路）。那不是结论，
 *    那是噪声。写进文档的数字请用 `--seconds=20 --repeat=3`（并看中位数）。
 *
 * 末行输出 `DONE fails=N` —— `fails` 记的是**正确性问题**（丢写、非预期响应、未捕获异常、
 * 发包端起不来），**不是**"慢"。慢要用数字说话，不靠红绿。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 场景定义与独立发包端**共用一份**（否则两边压的不是同一个东西，数字不可比）——
// 见 tools/bench-scenarios.mjs 顶部。
import { makeScenarios, scenarioNote } from './bench-scenarios.mjs';

/* ── 参数 ──────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : def;
};
const has = (name) => argv.includes('--' + name);

/** `30m` / `90s` / `1h` / `500`（裸数字按秒）→ 毫秒 */
function durationMs(s, def) {
  const m = /^(\d+(?:\.\d+)?)\s*([smh]?)$/.exec(String(s == null ? '' : s).trim());
  if (!m) return def;
  const n = Number(m[1]);
  return Math.round(n * ({ s: 1000, m: 60000, h: 3600000 }[m[2]] || 1000));
}

/**
 * ⚠️ 带值开关**不能**用 `argv.includes('--soak')` 判存在 —— 实际写法是 `--soak=30m`，
 * 精确匹配会漏掉，于是整个长稳分支被**静默跳过**、悄悄退回去跑阶梯（冒烟测试逮到过这个 bug，
 * 表现是"给了 --soak 却打了满屏阶梯"）。凡"值型"开关一律用下面这个 `hasVal`。
 */
const hasVal = (name) => argv.some((a) => a === '--' + name || a.startsWith('--' + name + '='));

const LEVELS = String(flag('levels', '1,4,8,16,32,64')).split(',').map((x) => Number(x.trim())).filter((n) => n > 0);
const SECONDS = durationMs(flag('seconds', '8'), 8000);
const REPEAT = Math.max(1, Number(flag('repeat', '1')) || 1);
const SOAK = hasVal('soak') ? durationMs(flag('soak', '30m'), 30 * 60000) : 0;
const SOAK_LEVEL = Number(flag('soak-level', '16')) || 16;
/**
 * 开环定速档位（每秒**发起**多少请求）。空数组 = 不跑开环。
 * 它是本项目此前唯一缺的那个压法 —— 回答"无限负载下在哪崩"（见 `runOpen` 的注释）。
 */
const OPEN_RATES = String(flag('open-rates', '')).split(',').map((x) => Number(x.trim())).filter((n) => n > 0);
const OPEN_SECONDS = durationMs(flag('open-seconds', '20'), 20000);
if (SOAK && OPEN_RATES.length) {
  console.log('✗ `--soak`（长时间漂移）与 `--open-rates`（过载拐点）不能同时给：');
  console.log('  它们压的是两个不同的问题，混在一次运行里两边的数都不可信。请分开跑。');
  process.exit(1);
}
const SCENARIOS = String(flag('scenarios', 'search,turn,mixed')).split(',').map((s) => s.trim()).filter(Boolean);
const MIX_READ = Number(flag('mix-read', '70')) || 70;   // mixed 场景里读的百分比
const AS_JSON = has('json');
/**
 * 开环的**发包端放在哪**：
 *   · `inproc`（默认）= 与服务器同一个进程（实现简单，但**测不出拐点** —— 见 runOpen 的注释）
 *   · `process`      = **另起一个进程**只做发包（真正的开环；服务端卡住时发包节拍不受影响）
 * ⚠️ 默认仍是 `inproc`：`process` 要 spawn 子进程，**它只该在独立机器/独占窗口里跑**，
 *    不该让"随手跑一次"也变成两进程。要结论就用 `process`。
 */
const OPEN_SENDER = String(flag('open-sender', 'inproc'));
/**
 * 语料规模：按**篇数**给，不按块数给。
 * 为什么改名（原先叫 `--seed-chunks`）：块数由分块器决定，"我要 3000 块却得到 294 块"
 * 会让**参数名本身**成为一句假话。现在只声明"灌几篇"，实测块数一律打印出来。
 */
const SEED_DOCS = Math.max(1, Number(flag('seed-docs', '15')) || 15);
const REQ_TIMEOUT = durationMs(flag('timeout', '30s'), 30000);

/* ── 独立发包端模式（`--sender`）────────────────────────────────────
 *
 * 真正的开环压测**必须**有一个独立发包端。原因见 `runOpen`：发包动作与服务端共用一个
 * 事件循环时，服务端一卡，发包节拍也被拖慢 —— 实测（第一次真跑，0.13.0）目标 30 req/s
 * **只发得出去 17.6**，于是"服务端从哪个速率开始崩"这个问题**永远问不出来**
 * （被客户端的上限先压死了，而且看起来像"系统扛住了"）。
 *
 * 本模式下这个进程**只发包**：不建库、不起服务、不导入任何 app 模块
 * （所以下面那些 `await import('../app/…')` 都不会执行）—— 它扮演的是"另一台机器上的人"。
 * 由主进程用 `--open-sender=process` 拉起；flag 复用（`--open-rates` / `--open-seconds` /
 * `--scenarios` / `--mix-read` / `--timeout` 都照样生效），另加几个环境变量传连接信息。
 * 末行输出 `SENDER <json>`，主进程取它。
 */
const SENDER_MODE = has('sender');
/** 事件循环滞后探针 —— 主进程与发包端都要用它，所以**必须在 SENDER_MODE 分支之前**建好。 */
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();

if (SENDER_MODE) {
  const BASE_URL = String(process.env.STI_SENDER_BASE || '');
  const COOKIE = String(process.env.STI_SENDER_COOKIE || '');
  if (!BASE_URL) {
    console.log('✗ 发包端缺少 STI_SENDER_BASE（应由主进程注入）—— 它不该被直接调用');
    process.exit(1);
  }
  const fetchJson = async (method, p, body) => {
    const h = { cookie: COOKIE };
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(BASE_URL + p, {
      method, headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQ_TIMEOUT),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, body: json, text };
  };
  const scen = SCENARIOS.includes('mixed') ? 'mixed' : SCENARIOS[0];
  const { makeScenarios, scenarioNote } = await import('./bench-scenarios.mjs');
  const scenMap = makeScenarios({
    fetchJson,
    kbId: String(process.env.STI_SENDER_KB || ''),
    cwd: String(process.env.STI_SENDER_CWD || ''),
    mixRead: MIX_READ,
  });
  console.log('（发包端：独立进程 ' + process.pid + '）');
  console.log('  场景 ' + scen + '：' + scenarioNote(scen, MIX_READ) + '｜每档 ' + (OPEN_SECONDS / 1000) + ' s');
  const rates = [];
  for (const rate of OPEN_RATES) {
    rates.push(await runOpen(scen, (i) => scenMap[scen](i), rate, OPEN_SECONDS));
  }
  console.log('SENDER ' + JSON.stringify(rates));
  process.exit(0);
}

/* ── 环境：必须在任何 app 模块之前设定（paths.mjs 在模块求值时读 DATA_DIR）── */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-benchc-'));
process.env.STI_DATA_DIR = tmp;
process.env.STI_LOG_LEVEL = 'error';            // 基准只关心数字，不刷业务日志
// 内核改由下面**显式注入测试替身**（0.21.4 起没有"内核模式"这个开关了）。
process.env.STI_RATE_LIMIT = '100000';          // 见"诚实边界 5"
process.env.STI_RATE_LIMIT_LOGIN = '100000';
process.env.STI_EMBED_PROVIDER = '';            // 不启用向量：本基准量的是 HTTP + SQLite 并发开销
process.env.STI_WORKERS = '1';

await import('../app/util/quiet-warnings.mjs');
const { ensureRuntimeDirs, DB_FILE, DATA_DIR } = await import('../app/paths.mjs');
const db = await import('../app/data/db.mjs');
const migrate = await import('../app/data/migrate.mjs');
const { loadConfig } = await import('../app/config.mjs');
const { createIdentityService } = await import('../app/platform/identity/service.mjs');
const { createKnowledgeService } = await import('../app/platform/knowledge/service.mjs');
const { createKernel } = await import('../app/kernel/index.mjs');
const { createKernelStub } = await import('./kernel-stub.mjs');
const { createServer } = await import('../app/http/server.mjs');
const audit = await import('../app/platform/governance/audit.mjs');
const { createGovernanceService } = await import('../app/platform/governance/service.mjs');
const { createOperationService } = await import('../app/platform/operation/service.mjs');
const { createModelService } = await import('../app/platform/model/service.mjs');
const { createScheduleService } = await import('../app/platform/schedule/service.mjs');
const { createNotifyService } = await import('../app/platform/notify/service.mjs');
const { encryptSecret, decryptSecret } = await import('../app/platform/identity/credentials.mjs');

console.log('');
console.log('STI HARNESS 并发与长稳基准（B11）');
console.log('='.repeat(74));

/* ── 装配（与 tools/test-http.mjs 同构）────────────────────────── */

ensureRuntimeDirs();
db.openDb(DB_FILE);
migrate.migrate();

const MASTER = crypto.randomBytes(32);
const identity = createIdentityService({ masterSecret: MASTER, sessionTtlMs: 3600 * 1000 });
const config = loadConfig();
// 显式注入测试替身：产品路径上没有"没配地址也能用"的内核（那层降级已删）。
const kernel = createKernel({ provider: createKernelStub(), reason: '回归用测试替身（不依赖真实内核）' });
const knowledge = createKnowledgeService({ config, audit, resolveCredential: () => null });
const operation = createOperationService({ dataDir: DATA_DIR });
const model = createModelService({});
const governance = createGovernanceService({ resolveProviders: (tid) => model.listProviders(tid) });
const notify = createNotifyService({ masterSecret: MASTER, encryptSecret, decryptSecret, allowLoopback: true });
const schedule = createScheduleService({ governance, operation, model, notify });
const { server, router } = createServer({
  config, kernel, identity, knowledge, governance, operation, model, notify, schedule,
  paths: { DATA_DIR }, startedAt: Date.now(),
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const BASE = 'http://127.0.0.1:' + server.address().port;

/* ── 登录：拿一个会话 Cookie（基准里所有请求共用同一个身份，压的是服务不是登录）── */

let cookie = '';
async function rawFetch(method, p, body) {
  const h = { cookie };
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method, headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQ_TIMEOUT),
  });
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pair = (sc || []).find((c) => c.startsWith('sti_session='));
  if (pair) cookie = pair.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, body: json, text };
}

const ADMIN = { username: 'benchadmin', password: 'Bench-Adm1n!23' };

const setup = await rawFetch('POST', '/api/identity/setup', {
  orgName: '并发基准组织', adminUsername: ADMIN.username,
  adminPassword: ADMIN.password, adminDisplayName: '基准管理员',
});
if (setup.status !== 200 && setup.status !== 201) {
  console.log('  ✗ 初始化失败：HTTP ' + setup.status + ' ' + setup.text.slice(0, 200));
  console.log('DONE fails=1');
  process.exit(1);
}
const login = await rawFetch('POST', '/api/identity/login', ADMIN);
if (login.status !== 200 || !cookie) {
  console.log('  ✗ 登录失败：HTTP ' + login.status + ' ' + login.text.slice(0, 200));
  console.log('DONE fails=1');
  process.exit(1);
}
const me = await rawFetch('GET', '/api/identity/me');
const TENANT = me.body && me.body.user ? me.body.user.orgId : null;
if (!TENANT) {
  console.log('  ✗ 取不到租户 id，无法做并发一致性核对');
  console.log('DONE fails=1');
  process.exit(1);
}

/* ── 预置一份检索语料（否则"检索"场景测的是空库，快得没有意义）────── */

const base = await rawFetch('POST', '/api/knowledge/bases', { name: '并发基准语料库' });
const KB = base.body && base.body.base ? base.body.base.id : null;
if (!KB) {
  console.log('  ✗ 建知识库失败：' + base.text.slice(0, 200));
  console.log('DONE fails=1');
  process.exit(1);
}
{
  // 一次导入就够（分块器会切很多块）；多灌几篇是为了让文档表也有一定规模。
  // ⚠️ 只声明"几篇" —— 实测块数在下面打印，别让参数名替分块器打包票。
  for (let d = 0; d < SEED_DOCS; d++) {
    const paragraphs = [];
    for (let p = 0; p < 200; p++) {
      paragraphs.push('第 ' + (d * 200 + p + 1) + ' 段：空间参考系，地理信息，数据治理，权限管理，'
        + '精度说明，要素分类，元数据，服务目录。本条用于并发基准。编号 C' + (d * 200 + p));
    }
    const r = await rawFetch('POST', '/api/knowledge/documents', {
      kbId: KB, text: paragraphs.join('\n\n'), filename: 'bench-' + d + '.txt', title: '基准文档 ' + d,
    });
    if (r.status !== 200 && r.status !== 201) {
      console.log('  ✗ 灌语料失败：HTTP ' + r.status + ' ' + r.text.slice(0, 200));
      console.log('DONE fails=1');
      process.exit(1);
    }
  }
}
// ⚠️ `chunks` 也没有 tenant_id（经 kb_id → knowledge_bases 归属租户）。写这类核对查询前
//    先看清楚表结构 —— 猜列名会抛"no such column"，并在并发脚本里被误读成"压测的问题"。
const chunkRows = db.get(
  'SELECT COUNT(*) AS n FROM chunks c JOIN knowledge_bases b ON b.id = c.kb_id WHERE b.tenant_id = ?',
  [String(TENANT)]
).n;
const baseRows = db.get('SELECT COUNT(*) AS n FROM knowledge_bases WHERE tenant_id = ?', [String(TENANT)]).n;

/* ── 场景定义 ────────────────────────────────────────────────────
 * ⚠️ 场景定义**不在这里**，在 `./bench-scenarios.mjs` —— 因为独立发包端（另一个进程）
 *    必须压**同一批**请求形状，否则"开环拐点"与"闭环饱和点"没有可比性。
 *    这里只把主进程自己的 `rawFetch`（会维护 cookie）注入进去。
 */
const scenarios = makeScenarios({
  fetchJson: (method, p, body) => rawFetch(method, p, body),
  kbId: KB, cwd: tmp, mixRead: MIX_READ,
});
const SCEN_NOTE = Object.fromEntries(
  ['search', 'readmin', 'turn', 'mixed'].map((s) => [s, scenarioNote(s, MIX_READ)])
);

/* ── 度量设施 ──────────────────────────────────────────────────── */

function rssMB() { return +(process.memoryUsage().rss / 1048576).toFixed(1); }

function percentiles(samples) {
  if (!samples.length) return { n: 0, min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  return {
    n: s.length,
    min: +s[0].toFixed(2), p50: +at(50).toFixed(2), p90: +at(90).toFixed(2),
    p95: +at(95).toFixed(2), p99: +at(99).toFixed(2), max: +s[s.length - 1].toFixed(2),
  };
}

/**
 * 跑一档并发。
 *
 * 并发模型：`level` 个**独立循环**，每个循环「发请求 → 等响应 → 记延迟 → 再发」。
 * 这是**闭环**（closed-loop）压测：并发数 = 同时在途的请求数上限。
 * 它回答的是"给 N 个同时在用的人，每人要等多久"；**不**回答"无限负载下系统在哪崩" ——
 * 后者由 `runOpen`（开环定速）回答。两者的分工见文件头"三种压法的分工"。
 */
async function runLevel(name, one, level, ms, quiet = false) {
  const lat = [];
  const errors = [];
  let okCount = 0;
  let wroteEvents = 0;
  /**
   * 成功的**写**请求数 —— 只数真写，不数读。
   * ⚠️ 为什么单开一个计数：`okCount` 在 `mixed` 场景里把**读**请求也算进去了，
   *    拿它去跟"新建会话数"对账会把 70% 的读也算成"提交的回合"，于是那条对账**永远不平**、
   *    也永远发现不了真问题 —— 一个口径错的核对比没有核对更危险（它**看起来**在对账）。
   *    判据：只有 `turn` 场景的 `one()` 会返回 `wrote` 字段，所以 `typeof r.wrote === 'number'` 即"这次是真写"。
   */
  let writesOk = 0;
  const rssStart = rssMB();
  let rssPeak = rssStart;
  const rssSeries = [rssStart];
  lag.reset();

  const memTimer = setInterval(() => {
    const m = rssMB();
    rssSeries.push(m);
    if (m > rssPeak) rssPeak = m;
  }, 250);

  const deadline = performance.now() + ms;
  let idx = 0;

  async function worker(w) {
    while (performance.now() < deadline) {
      const t0 = performance.now();
      let r;
      try {
        r = await one(idx++);
      } catch (e) {
        r = { ok: false, note: '异常：' + (e && e.message) };
      }
      lat.push(performance.now() - t0);
      if (r.ok) {
        okCount++;
        wroteEvents += r.wrote || 0;
        if (typeof r.wrote === 'number') writesOk++;   // 带 wrote 的只有 turn 分支 ⇒ 这一条就是"真写"
      } else if (errors.length < 8) errors.push(r.note || '未知');
    }
  }

  await Promise.all(Array.from({ length: level }, (_, w) => worker(w)));
  clearInterval(memTimer);

  const wall = ms / 1000;   // 采样窗就是墙钟时长（下面按真实耗时再算一遍）
  const p = percentiles(lat);
  const total = lat.length;
  const errCount = total - okCount;
  const out = {
    level, seconds: +(ms / 1000).toFixed(1),
    requests: total, ok: okCount, errors: errCount,
    errorRate: total ? +(errCount / total * 100).toFixed(3) : 0,
    throughput: +(total / wall).toFixed(1),
    latency: p,
    eventsWritten: wroteEvents,
    writesOk,
    rssStartMB: rssStart, rssPeakMB: rssPeak, rssEndMB: rssMB(),
    eventLoopLagMs: { p50: +(lag.percentile(50) / 1e6).toFixed(2), p95: +(lag.percentile(95) / 1e6).toFixed(2), max: +(lag.max / 1e6).toFixed(2) },
    errorSamples: errors,
  };
  lag.reset();

  if (!quiet) {
    console.log('  ' + String(level).padStart(4) + ' 路  '
      + String(out.throughput).padStart(7) + ' req/s  '
      + 'P50 ' + String(p.p50).padStart(8) + '  P95 ' + String(p.p95).padStart(8) + '  P99 ' + String(p.p99).padStart(8) + ' ms  '
      + '错误 ' + String(errCount).padStart(4) + '  '
      + 'RSS ' + String(rssStart).padStart(6) + '→' + String(out.rssEndMB).padStart(6) + ' MB  '
      + 'ELag p95 ' + String(out.eventLoopLagMs.p95).padStart(6) + ' ms');
    if (errors.length) {
      for (const e of errors.slice(0, 3)) console.log('        ! ' + e);
      if (errors.length > 3) console.log('        ! （另有 ' + (errors.length - 3) + ' 类未显示）');
    }
  }
  return out;
}

/**
 * 开环定速跑一档 —— **回答"无限负载下在哪崩"**。
 *
 * 与 `runLevel`（闭环：发一个 → 等响应 → 再发）的根本区别：
 *   · **闭环**里"在途请求数"永远 ≤ 并发数，系统再慢也只会让每个 worker 变慢，**永不堆积**。
 *     所以闭环**测不出过载**，它只会显示"延迟变大" —— 这正是它回答不了"在哪崩"的原因。
 *   · **开环**按**固定速率**发、**不等响应**，于是当速率超过处理能力时，请求开始**堆积**，
 *     最终表现为**超时 / 错误率上升**与延迟爆炸。那个"从哪个速率开始崩"的点才是结论。
 *
 * ⚠️ 单进程内做开环的**固有局限**（必须和数字一起说，否则会被误读）：
 *   发包动作本身也跑在这个**正被压的事件循环**上。当服务端卡住时，**发包节拍也会被拖慢**，
 *   于是"目标速率"发不出去。所以本档同时报 **目标速率 / 实际发出速率 / 完成速率** 三个数：
 *   只看"目标速率"会把"我们自己发不出去"误读成"系统扛住了"。
 *
 *   ⇒ **所以要拐点就用 `--open-sender=process`**：那条路把这个函数原样搬到**另一个进程**里跑
 *     （见 `runOpenViaChild`），发包端于是有自己的事件循环，节拍不再被服务端拖慢。
 *     实测差别很大：同进程目标 30 req/s 只发得出 17.6，独立进程能真的按目标发。
 *     ⚠️ 但两个进程仍在**同一台机**上 —— 那是"争 CPU"，不是"发包节拍"，只有换机器才能去掉。
 */
async function runOpen(name, one, ratePerSec, ms) {
  const lat = [];
  const errors = [];
  let sent = 0;
  let okCount = 0;
  let writesOk = 0;
  let inflight = 0;
  let inflightPeak = 0;
  const rssStart = rssMB();
  let rssPeak = rssStart;
  lag.reset();
  const memTimer = setInterval(() => { const m = rssMB(); if (m > rssPeak) rssPeak = m; }, 250);

  const interval = 1000 / ratePerSec;
  const startedAt = performance.now();
  const deadline = startedAt + ms;
  let nextAt = startedAt;
  let idx = 0;
  const pending = [];

  while (performance.now() < deadline) {
    const now = performance.now();
    if (now < nextAt) {
      // 还没到下一个发包点 —— 睡一小段（上限 5ms，避免节拍被 sleep 精度拖歪）
      await new Promise((r) => setTimeout(r, Math.min(nextAt - now, 5)));
      continue;
    }
    sent++;
    const st = now;
    inflight++;
    if (inflight > inflightPeak) inflightPeak = inflight;
    pending.push((async () => {
      let r;
      try { r = await one(idx++); }
      catch (e) { r = { ok: false, note: '异常：' + (e && e.message) }; }
      lat.push(performance.now() - st);
      if (r.ok) { okCount++; if (typeof r.wrote === 'number') writesOk++; }
      else if (errors.length < 8) errors.push(r.note || '未知');
      inflight--;
    })());
    nextAt += interval;
    // ⚠️ 落后太多时**不追赶**：把基准点拉回当前时刻。追赶会瞬间打出一串尖峰，
    //    把"系统慢"记成"瞬时超载"，读数就废了。代价是实际速率低于目标 —— 而这个代价
    //    本身就是要如实报出来的信号（见上面的局限说明）。
    if (nextAt < now) nextAt = now;
  }
  await Promise.allSettled(pending);
  clearInterval(memTimer);

  const wall = (performance.now() - startedAt) / 1000;
  const p = percentiles(lat);
  const completed = lat.length;
  const errCount = completed - okCount;
  const out = {
    targetRate: ratePerSec, seconds: +wall.toFixed(1),
    sent, completed, ok: okCount, errors: errCount, writesOk,
    actualSendRate: +(sent / wall).toFixed(1),
    completionRate: +(completed / wall).toFixed(1),
    errorRate: completed ? +(errCount / completed * 100).toFixed(3) : 0,
    inflightPeak,
    latency: p,
    rssStartMB: rssStart, rssPeakMB: rssPeak, rssEndMB: rssMB(),
    eventLoopLagMs: {
      p50: +(lag.percentile(50) / 1e6).toFixed(2),
      p95: +(lag.percentile(95) / 1e6).toFixed(2),
      max: +(lag.max / 1e6).toFixed(2),
    },
    errorSamples: errors,
  };
  lag.reset();

  console.log('  目标 ' + String(ratePerSec).padStart(6) + ' req/s  '
    + '实际发出 ' + String(out.actualSendRate).padStart(7) + '  '
    + '完成 ' + String(out.completionRate).padStart(7) + ' req/s  '
    + 'P50 ' + String(p.p50).padStart(8) + '  P95 ' + String(p.p95).padStart(8) + '  P99 ' + String(p.p99).padStart(8) + ' ms  '
    + '在途峰值 ' + String(inflightPeak).padStart(5) + '  '
    + '错误 ' + String(errCount).padStart(5) + '（' + out.errorRate + '%）');
  if (errors.length) {
    for (const e of errors.slice(0, 3)) console.log('        ! ' + e);
    if (errors.length > 3) console.log('        ! （另有 ' + (errors.length - 3) + ' 类未显示）');
  }
  return out;
}

/**
 * 用**独立进程**做开环定速（`--open-sender=process`）。
 *
 * 与 `runOpen`（同进程）的唯一区别是"谁在发包"：这里拉起一个**只发包、不碰库、不起服务**
 * 的同名脚本进程，把连接信息经环境变量给它。为什么要这么绕：
 *   · 服务端卡住时，**同进程的发包循环会被饿死**（实测目标 30 req/s 只发得出 17.6），
 *     于是"实际发出 < 目标"这个信号分不清是"服务端撑不住"还是"客户端发不出"；
 *   · 换成独立进程后，发包端有自己的事件循环 —— 它**始终按目标速率发**，
 *     于是延迟爆炸与错误率上升就真的是服务端的事了。
 *
 * ⚠️ 这仍然**不是**"多机压测"：两个进程在同一台机上争 CPU。它解决的是"发包节拍被服务端
 *    拖慢"这个问题，**没有**解决"客户端与服务器争 CPU"这个问题（后者要另一台机器）。
 *    所以本模式下的数字比同进程模式**更接近真实**，但仍要带上这条口径读。
 *
 * 子进程的输出**原样转发**给操作者（每档一行的可读结果由子进程打印），
 * 末行 `SENDER <json>` 是结构化结果（人类那一行只是它的渲染）。
 */
function runOpenViaChild({ scen, base, cookie, kbId, cwd }) {
  const args = [
    fileURLToPath(import.meta.url), '--sender',
    '--open-rates=' + OPEN_RATES.join(','),
    '--open-seconds=' + (OPEN_SECONDS / 1000) + 's',
    '--scenarios=' + SCENARIOS.join(','),
    '--mix-read=' + MIX_READ,
    '--timeout=' + (REQ_TIMEOUT / 1000) + 's',
    '--soak-level=' + SOAK_LEVEL,   // 无意义但无害：只是让子进程参数与主进程完全一致
  ];
  const env = {
    ...process.env,
    STI_SENDER_BASE: base, STI_SENDER_COOKIE: cookie, STI_SENDER_KB: kbId, STI_SENDER_CWD: cwd,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
      // 子进程的可读输出实时转发 —— 30 分钟的默认值下，"什么都不显示"会让人以为卡死了
      for (const line of String(d).split('\n')) {
        if (line.trim() && !line.startsWith('SENDER ')) console.log('  ' + line);
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      const hit = out.split('\n').find((l) => l.startsWith('SENDER '));
      if (code !== 0 || !hit) {
        return reject(new Error('发包端异常退出（code=' + code + '）：' + (err || out).slice(-500)));
      }
      let rates;
      try { rates = JSON.parse(hit.slice('SENDER '.length)); }
      catch (e) { return reject(new Error('发包端结果无法解析：' + (e && e.message))); }
      resolve({ rates });
    });
  });
}

/* ── 机器信息 ──────────────────────────────────────────────────── */

const report = {
  machine: {
    platform: process.platform + ' ' + process.arch,
    cpu: (os.cpus()[0] || {}).model || '未知',
    cores: os.cpus().length,
    memGB: Math.round(os.totalmem() / 1073741824 * 10) / 10,
    node: process.versions.node,
  },
  config: {
    kernelReady: kernel.ready, levels: LEVELS, secondsPerLevel: SECONDS / 1000, repeatPerLevel: REPEAT,
    scenarios: SCENARIOS, mixReadPct: MIX_READ,
    rateLimit: '已放到 100000/分钟（见诚实边界 5）',
    seededDocs: SEED_DOCS, measuredChunks: chunkRows, measuredBases: baseRows,
    routes: router.stats().total,
  },
  scenarioNotes: SCEN_NOTE,
  results: {},
  soak: null,
  openLoop: null,
  correctness: {},
  caveats: [
    '内核是 测试替身：回合耗时里**没有模型时间**，只反映平台自身开销，不能外推成端到端对话延迟。',
    (OPEN_RATES.length && OPEN_SENDER === 'process')
      ? '开环发包端是独立进程，但仍在同一台机：去掉了"发包节拍被拖慢"，没去掉"客户端与服务器争 CPU"。'
      : '客户端与服务器同进程同机：对"客户端在另一台机"偏悲观，对共享缓存偏乐观，两头都要说。',
    'SQLite 单写者：写请求排在同一把写锁上，"写并发"实际是排队+调度开销，不是并行写。',
    '磁盘是本机的（WAL + synchronous=NORMAL），换盘即换数字。',
    '本基准把 IP 限流放到 100000/分钟；**默认 600 次/分钟/IP 才是业务最先撞到的墙**（反代后共用出口 IP 会更早）。',
    '单机单进程数字：没有分布式锁，并发配额是进程内存 —— 它同时就是上线的天花板。',
    '闭环压测：并发数 = 同时在途请求上限；它不回答"无限负载下在哪崩"—— 那个问题由开环定速（--open-rates）回答，两者不可互相替代。',
  ],
};

console.log('');
console.log('机器      ' + report.machine.cpu + ' · ' + report.machine.cores + ' 核 · '
  + report.machine.memGB + ' GB · ' + report.machine.platform + ' · Node ' + report.machine.node);
console.log('服务      随机端口 ' + BASE + '｜路由 ' + report.config.routes + ' 条｜内核 ' + (kernel.ready ? '已接入' : '未接入'));
console.log('语料      ' + chunkRows.toLocaleString('en-US') + ' 个 chunk（' + baseRows + ' 个库，'
  + '无向量，检索走 FTS5 bm25 + bigram）');
{
  // ⚠️ 这一行必须**只说本次真的会跑的模式**：原先无条件写"每档 X s 闭环"，
  //    于是 `--soak` / `--open-rates` 单独跑时也会印一句它并不会做的事（与长稳那段同一个坑）。
  const modes = [];
  if (SOAK) modes.push('长稳：固定 ' + SOAK_LEVEL + ' 路 × ' + (SOAK / 60000).toFixed(1) + ' 分钟');
  if (OPEN_RATES.length) modes.push('开环定速：不等响应，速率 ' + OPEN_RATES.join('/') + ' req/s，每档 ' + (OPEN_SECONDS / 1000) + ' s');
  if (!SOAK && !OPEN_RATES.length) modes.push('闭环阶梯：每档 ' + (SECONDS / 1000) + ' s');
  console.log('口径      ' + modes.join('；') + '；读场景 = 检索，写场景 = 建会话 + 一轮回合');
}

const sessionsBefore = db.get('SELECT COUNT(*) AS n FROM agent_sessions WHERE tenant_id = ?', [String(TENANT)]).n;

/**
 * `fails` 记的是**正确性**问题（丢写 / 非预期响应 / 未捕获异常 / 发包端起不来），
 * **不是**"慢"。声明放在这里（而不是收尾处）是因为开环那段也要往里记 ——
 * `let` 有 TDZ，晚声明会在运行到开环时直接抛 ReferenceError。
 */
let fails = 0;

/* ── 阶梯 ──────────────────────────────────────────────────────── */

if (SOAK) {
  /* 长稳模式：固定并发跑很久，看的是"漂移"而不是"峰值" */
  console.log('');
  console.log('长稳模式：固定 ' + SOAK_LEVEL + ' 路，跑 ' + (SOAK / 60000).toFixed(1) + ' 分钟');
  console.log('（看的是内存与延迟是否随时间漂移 —— 峰值由阶梯模式给）');
  report.soak = {
    level: SOAK_LEVEL, minutes: +(SOAK / 60000).toFixed(1),
    scenario: SCENARIOS.includes('mixed') ? 'mixed' : SCENARIOS[0],
  };
  const slice = 60000;   // 每分钟切一段，观察漂移
  const segs = [];
  const soakScenario = report.soak.scenario;
  const one = (i) => scenarios[soakScenario](i);
  const remaining = SOAK;
  let done = 0;
  let baseIdx = 0;
  let soakWritesOk = 0;
  while (done < remaining) {
    const chunk = Math.min(slice, remaining - done);
    const r = await runLevel(soakScenario, (i) => one(baseIdx + i), SOAK_LEVEL, chunk);
    segs.push({
      minuteFrom: +(done / 60000).toFixed(1), throughput: r.throughput,
      p95: r.latency.p95, errorRate: r.errorRate, rssEndMB: r.rssEndMB,
      eventLoopLagP95: r.eventLoopLagMs.p95,
    });
    soakWritesOk += r.writesOk;
    baseIdx += r.requests;
    done += chunk;
  }
  report.soak.segments = segs;
  report.soak.writesOk = soakWritesOk;
  const first = segs[0] || {};
  const last = segs[segs.length - 1] || {};
  report.soak.drift = {
    throughputPct: first.throughput ? +(((last.throughput - first.throughput) / first.throughput) * 100).toFixed(1) : null,
    p95Pct: first.p95 ? +(((last.p95 - first.p95) / first.p95) * 100).toFixed(1) : null,
    rssDeltaMB: (last.rssEndMB != null && first.rssEndMB != null) ? +(last.rssEndMB - first.rssEndMB).toFixed(1) : null,
  };
  console.log('');
  console.log('  首段 → 末段：吞吐 ' + first.throughput + ' → ' + last.throughput + ' req/s（'
    + report.soak.drift.throughputPct + '%）｜P95 ' + first.p95 + ' → ' + last.p95 + ' ms（'
    + report.soak.drift.p95Pct + '%）｜RSS 变化 ' + report.soak.drift.rssDeltaMB + ' MB');

  // ⚠️ 阶梯**只在给了 `--with-levels` 时才补跑**（见下面那个 if 的条件）。
  //    原先这里**无条件**打印"长稳结束，补跑一组阶梯"，于是默认长稳跑完会打印一句
  //    **它并没有做的事** —— 实测（0.12.1 期间第一次真跑长稳）就撞上了：文案说有、汇总里没有。
  //    长稳本身就是 30 分钟的采样，再叠 3 场景 × 6 档阶梯会把总时长推到不可接受；
  //    所以保留"默认不补跑"，只把话改成真的。
  console.log('');
  console.log(hasVal('with-levels')
    ? '（长稳结束，补跑一组阶梯以给出容量数字）'
    : '（如需容量数字，加 --with-levels 会在长稳之后补跑一组阶梯 —— 本次没有）');
}

/*
 * 阶梯的跑法：
 *   · 长稳模式（`--soak`）下默认不跑，除非显式 `--with-levels`
 *   · 开环模式（`--open-rates`）下默认也不跑 —— 开环会把系统推到过载，**先过载再量容量**
 *     会让阶梯的数字失真（队列里还堵着上一档的请求）。要两者同跑请用 `--with-levels`。
 *   · 其余情况照跑。
 */
const RUN_LADDER = (!SOAK && !OPEN_RATES.length) || hasVal('with-levels');
if (RUN_LADDER) {
  for (const scen of SCENARIOS) {
    if (!scenarios[scen]) { console.log('  ! 未知场景，已跳过：' + scen); continue; }
    console.log('');
    console.log('场景 ' + scen + '：' + SCEN_NOTE[scen]);
    if (REPEAT > 1) console.log('  （每档跑 ' + REPEAT + ' 轮，"吞吐"取中位数 —— 单轮抖动可达数十个百分点，不能当曲线读）');
    console.log('  ' + '并发'.padStart(4) + '  ' + '吞吐(req/s)'.padStart(20) + '  ' + '延迟分位（ms）'.padStart(30));
    report.results[scen] = [];
    for (const level of LEVELS) {
      const rounds = [];
      for (let k = 0; k < REPEAT; k++) {
        rounds.push(await runLevel(scen, (i) => scenarios[scen](i), level, SECONDS, k > 0));
      }
      const tps = rounds.map((r) => r.throughput).sort((a, b) => a - b);
      const median = tps.length % 2 ? tps[(tps.length - 1) / 2] : (tps[tps.length / 2 - 1] + tps[tps.length / 2]) / 2;
      // 延迟与错误按"中位吞吐那一轮"代表，避免把不同轮次的数字混着报（那会造出一个不存在的样本）
      const rep = rounds.find((r) => r.throughput === median) || rounds[0];
      const agg = {
        ...rep,
        throughput: +median.toFixed(1),
        throughputMin: tps[0], throughputMax: tps[tps.length - 1],
        throughputSpreadPct: tps[0] ? +(((tps[tps.length - 1] - tps[0]) / tps[0]) * 100).toFixed(1) : null,
        // ⚠️ 上面 `...rep` 带进来的 `writesOk` 只是**代表轮**（中位吞吐那一轮）的量。
        //    错误率 / 延迟按代表轮报是对的（避免混轮造出不存在的样本），但**错写对账**要的是
        //    "本档所有轮次真的提交了多少回合" —— 用代表轮的 `writesOk` 会在 `--repeat=2` 时少算一半，
        //    于是"成功回合 ≠ 新建会话"这条断言会**假红**（实测：5994 vs 11920，正好约一半）。
        writesOkTotal: rounds.reduce((s, r) => s + (r.writesOk || 0), 0),
        rounds: rounds.map((r) => ({ throughput: r.throughput, p50: r.latency.p50, p95: r.latency.p95, errors: r.errors })),
      };
      report.results[scen].push(agg);
      console.log('  ' + String(level).padStart(4) + ' 路  '
        + String(agg.throughput).padStart(8) + ' req/s  '
        + 'P50 ' + String(rep.latency.p50).padStart(8) + '  P95 ' + String(rep.latency.p95).padStart(8)
        + '  P99 ' + String(rep.latency.p99).padStart(8) + ' ms  '
        + '错误 ' + String(rep.errors).padStart(4) + '  '
        + (REPEAT > 1 ? '（' + tps[0] + '~' + tps[tps.length - 1] + '，波动 ' + agg.throughputSpreadPct + '%）' : '')
        + (REPEAT > 1 ? '' : '  RSS ' + rep.rssStartMB + '→' + rep.rssEndMB + ' MB  ELag p95 ' + rep.eventLoopLagMs.p95 + ' ms'));
      if (rep.errors) for (const e of rep.errorSamples.slice(0, 2)) console.log('        ! ' + e);
    }
  }
}

/* ── 开环定速：找"从哪个速率开始崩" ────────────────────────────── */

if (OPEN_RATES.length) {
  const scen = SCENARIOS.includes('mixed') ? 'mixed' : SCENARIOS[0];
  console.log('');
  console.log('开环定速（**不等响应**按固定速率发 —— 找的是"从哪个速率开始堆积到崩"，不是延迟曲线）');
  console.log('  场景 ' + scen + '：' + SCEN_NOTE[scen] + '｜每档 ' + (OPEN_SECONDS / 1000) + ' s');
  if (OPEN_SENDER === 'process') {
    report.caveats.push('开环定速（`--open-sender=process`）的发包端是**独立进程**，但仍在**同一台机**上。'
      + '它解决了"服务端一卡，发包节拍也被拖着走"这个问题（同进程开环实测：目标 30 req/s 只发得出 17.6，'
      + '拐点永远问不出来），但**没有**解决"客户端与服务器争 CPU"。'
      + '要那一条需要另一台机器 —— 那才是"多机压测"，本项目未做。');
  } else {
    report.caveats.push('⚠️ 本次开环用的是**同进程**发包端（默认 inproc）：发包循环与服务器共用一个事件循环，'
      + '"实际发出 < 目标"分不清是服务端撑不住还是客户端发不出 —— **本次的速率数字不能当拐点读**，'
      + '要拐点请加 --open-sender=process。');
  }
  report.openLoop = {
    scenario: scen, secondsPerRate: OPEN_SECONDS / 1000,
    sender: OPEN_SENDER === 'process' ? '独立进程（另一事件循环，同一台机）' : '同进程（与服务器共用一个事件循环）',
    rates: [],
  };
  if (OPEN_SENDER === 'process') {
    console.log('  发包端：**独立进程**（真正的开环 —— 服务端卡住时发包节拍不受影响）');
    try {
      const r = await runOpenViaChild({ scen, base: BASE, cookie, kbId: KB, cwd: tmp });
      report.openLoop.rates = r.rates;
    } catch (e) {
      // 发包端自己起不来时**如实失败**，不要悄悄退回同进程 —— 那会给出一个看起来正常、
      // 实际上答非所问的数字（同"给了 --soak 却静默退回阶梯"那一类坑）。
      console.log('  ✗ 独立发包端失败：' + (e && e.message));
      report.openLoop.error = String((e && e.message) || e);
      fails += 1;
    }
  } else {
    // 同进程：**这个模式问不出拐点**，所以把结论写死在这里，别让读者误读那两个数
    console.log('  ⚠️ 同进程开环：发包循环与服务器共用一个事件循环，服务端一卡发包也被拖慢，');
    console.log('     所以"实际发出 < 目标"分不清是服务端撑不住还是客户端发不出 —— 要拐点请用 --open-sender=process');
    for (const rate of OPEN_RATES) {
      report.openLoop.rates.push(await runOpen(scen, (i) => scenarios[scen](i), rate, OPEN_SECONDS));
    }
  }
  // 拐点：错误率第一次 > 0 的那一档（没有就如实说"这一档范围内没崩"）
  const firstBad = report.openLoop.rates.find((r) => r.errorRate > 0);
  report.openLoop.knee = firstBad ? firstBad.targetRate : null;
  console.log('');
  console.log(firstBad
    ? '  ⇒ 拐点：**' + firstBad.targetRate + ' req/s 开始出现错误**（错误率 ' + firstBad.errorRate + '%）'
      + ' —— 这就是本次测出的"无限负载下在哪崩"。'
    : '  ⇒ 本次最高档 ' + OPEN_RATES[OPEN_RATES.length - 1] + ' req/s **仍未出现错误**：'
      + '在这个速率范围内没有崩。要更高的拐点就继续把 --open-rates 往上加。');
}

/* ── 正确性核对：并发之后，"提交了多少"必须等于"库里有多少" ─────────
 *
 * 为什么这条比任何数字都重要：一个丢写的系统可以**非常快**。
 * 并发下最容易出的两类问题是「事务边界没兜住」与「同一行被两次写覆盖」，
 * 它们都表现为"吞吐很高、数据不对"。所以这里直接查库对账。
 */

const sessionsAfter = db.get('SELECT COUNT(*) AS n FROM agent_sessions WHERE tenant_id = ?', [String(TENANT)]).n;
// ⚠️ `events` 表**没有** tenant_id（它是 agent_sessions 的子表），要经会话 join 过来。
//    直接写 WHERE tenant_id 会抛"no such column"—— 这类错在并发脚本里很容易被当成"压测的问题"。
const eventsAfter = db.get(
  'SELECT COUNT(*) AS n FROM events e JOIN agent_sessions s ON s.id = e.session_id WHERE s.tenant_id = ?',
  [String(TENANT)]
).n;

/**
 * 阶梯里成功提交的**写**请求数。
 * ⚠️ 用 `writesOk` 而不是 `ok`：`mixed` 场景里 70% 是读，用 `ok` 会把读也算成"提交的回合"。
 *    原先正是这么写的，于是这个数比真实回合数大一截 —— 对账因此**永远不平**，
 *    也就永远报不出真问题（口径错的对账看着像在工作，这是它最坏的地方）。
 */
let turnsSubmitted = 0;
for (const scen of Object.keys(report.results)) {
  if (scen === 'turn' || scen === 'mixed') {
    // ⚠️ 取 `writesOkTotal`（本档**所有轮次**之和），不是 `writesOk`（只代表轮）。
    //    `--repeat=2` 时用后者会少算一半 ⇒ 对账假红（"看着像在工作"的对账最坏）。
    for (const row of report.results[scen]) {
      turnsSubmitted += row.writesOkTotal != null ? row.writesOkTotal : (row.writesOk || 0);
    }
  }
}
// 长稳与阶梯是**不同时间段**的请求，都要算进去（长稳的写数按段累加在 report.soak.writesOk）
if (report.soak) turnsSubmitted += report.soak.writesOk || 0;

// 开环的写请求**单列**，不并入上面那个数（原因见下）
let openWrites = 0;
if (report.openLoop) for (const r of report.openLoop.rates) openWrites += r.writesOk || 0;

const sessionGap = sessionsAfter - sessionsBefore;
const wroteAny = SCENARIOS.some((s) => s === 'turn' || s === 'mixed');
/**
 * 核对规则：**每个成功的写请求恰好落成一个会话**（`/api/kernel/sessions` 是唯一的建会话入口）。
 * 所以"成功提交的回合数"与"新建会话数"必须精确相等。不等就说明
 * 「建了会话但回合没成真」或「会话没建成却记了成功」—— 这正是丢写/写链路断裂的形态，
 * 而它**极容易被高吞吐掩盖**（一个丢写的系统可以非常快）。
 *
 * ⚠️ 但**开环下这条等式不适用**：开环追求的就是把系统压到过载，此时"客户端超时"与
 *    "服务端其实已经落库"会**同时发生**（请求超时返回，但事务其实已提交），
 *    于是会话增量**天然会大于**成功计数。强行要求相等，等于把"压出了过载"这个**预期结果**
 *    记成缺陷。所以开环模式**只报告事实、不做等式判定**（strict=false）。
 */
const strict = !report.openLoop;
const correctnessOk = !wroteAny || !strict || turnsSubmitted === sessionGap;

report.correctness = {
  sessionsBefore, sessionsAfter, sessionsCreated: sessionGap,
  turnsSubmitted, openWrites, eventsTotal: eventsAfter,
  wroteAny, strict, ok: correctnessOk,
};
console.log('');
console.log('正确性核对（并发下的"丢写"是最容易被高吞吐掩盖的问题）');
console.log('  会话：' + sessionsBefore + ' → ' + sessionsAfter + '（新增 ' + sessionGap + '）');
console.log('  成功提交的回合（闭环）：' + turnsSubmitted
  + ((strict && wroteAny) ? '（必须**精确等于**新建会话数 ' + sessionGap + '）' : '（本次无闭环写场景）'));
if (report.openLoop) {
  console.log('  成功提交的回合（开环）：' + openWrites
    + ' —— 开环下「超时但已落库」与「真的丢了」无法从计数上分开，故此档**不做等式判定**');
}
console.log('  事件总行数：' + eventsAfter.toLocaleString('en-US'));
if (strict && wroteAny && !correctnessOk) {
  console.log('  ✗ 对不上：成功回合 ' + turnsSubmitted + ' ≠ 新建会话 ' + sessionGap
    + ' —— "建了会话却没有回合成真"或反之，这正是丢写/写链路断裂的形态');
} else if (strict && wroteAny) {
  console.log('  ✓ 对得上：每个成功的回合都恰好落成一个会话，没有"提交了却没落库"');
}

/* ── 汇总 ──────────────────────────────────────────────────────── */

console.log('');
console.log('='.repeat(74));
const f = (p) => String(p.p50).padStart(7) + ' /' + String(p.p95).padStart(8) + ' /' + String(p.p99).padStart(8);
console.log('汇总（P50 / P95 / P99，ms）');
for (const [scen, rows] of Object.entries(report.results)) {
  console.log('  ' + scen + '（' + SCEN_NOTE[scen] + '）');
  for (const r of rows) {
    console.log('    ' + String(r.level).padStart(4) + ' 路   '
      + String(r.throughput).padStart(8) + ' req/s   '
      + f(r.latency) + '   错误 ' + r.errors
      + (REPEAT > 1 ? '   轮间波动 ' + r.throughputSpreadPct + '%' : ''));
  }
}
if (report.soak) {
  console.log('  长稳 ' + report.soak.level + ' 路 × ' + report.soak.minutes + ' 分钟：吞吐漂移 '
    + report.soak.drift.throughputPct + '%｜P95 漂移 ' + report.soak.drift.p95Pct + '%｜RSS 变化 '
    + report.soak.drift.rssDeltaMB + ' MB');
}
if (report.openLoop) {
  console.log('  开环定速（' + report.openLoop.scenario + '，每档 ' + report.openLoop.secondsPerRate + ' s）：'
    + (report.openLoop.knee
      ? '**拐点 ' + report.openLoop.knee + ' req/s**'
      : '最高档仍未崩（范围内没找到拐点）'));
  for (const r of report.openLoop.rates) {
    console.log('    ' + String(r.targetRate).padStart(6) + ' req/s 目标  '
      + '发出 ' + String(r.actualSendRate).padStart(7) + '  完成 ' + String(r.completionRate).padStart(7) + ' req/s  '
      + 'P95 ' + String(r.latency.p95).padStart(8) + ' ms  在途峰值 ' + String(r.inflightPeak).padStart(5)
      + '  错误 ' + r.errors);
  }
}
console.log('');
console.log('口径（**引用这些数字时必须一并带上**）：');
for (const c of report.caveats) console.log('  · ' + c);
console.log('');
console.log('仍未做（如实，别当已经做了）：**多机**压测（回答"能不能横向扩"）——');
console.log('  当前架构**不支持**横向扩（单进程 + 无分布式锁，见 deploy.md），所以这不是"欠一次压测"，');
console.log('  而是一条**架构决策**：要做多机，先得有分布式锁与共享状态，压测才有意义。');
console.log('  （注意区分：`--open-sender=process` 的独立发包端是"另一个进程"，但仍在**同一台机**上 ——');
console.log('    它解决"发包节拍被服务端拖慢"，不解决"客户端与服务器争 CPU"。）');

/* ── 收尾 ──────────────────────────────────────────────────────── */

for (const [scen, rows] of Object.entries(report.results)) {
  for (const r of rows) if (r.errors > 0) fails += 1;   // 错误率非 0 一律记问题
}
if (report.soak && report.soak.segments.some((s) => s.errorRate > 0)) fails += 1;
// 对账不平也是**正确性**问题（而不是"慢"）—— 它必须进 fails，否则这段核对就只是装饰
if (report.correctness.ok === false) fails += 1;

if (AS_JSON) console.log('JSON ' + JSON.stringify(report));

console.log('');
console.log('基准检查 ' + fails + ' 项不达标（记的是**正确性**问题；慢要用上面的数字说，不用红绿）');
console.log('DONE fails=' + fails);

try { await knowledge.close(); } catch { /* ignore */ }
try { db.closeDb(); } catch { /* ignore */ }
await new Promise((r) => server.close(r));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fails ? 1 : 0;
