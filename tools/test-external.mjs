/**
 * 外部内核端到端回归 —— 证明"平台接上真实 DSH 之后，对话真的能跑"。
 *
 * 为什么必须有它（docs/history/assessment-0.6.0.md §2 P0-A）：
 *   0.6.0 交付时的最大隐患是：**所有回归都在 测试替身下跑**，
 *   因此"真实内核下建会话/发回合全部 501"这种事永远不会被任何脚本发现。
 *   测试替身 绿 = 治理层没问题，**不等于**平台能用。
 *
 * 本脚本把"能不能用"变成一条断言：
 *   真上游 → 装配（external 内核）→ 初始化 → 登录 → 建会话 → 发一轮 → 拿回事件。
 *
 * 诚实原则：
 *   · 本机没有可用的上游 → **SKIP**（明确说明原因，绝不计入"通过"）。
 *   · 上游在但某一步失败 → **FAIL**，并把上游的原始错误码/消息打出来，不吞。
 *
 * 用法：
 *   node tools/test-external.mjs                 # 用环境变量 / data/config.json 里的上游
 *   node tools/test-external.mjs --dev-config     # 开发期：复用同级工程的 DSH 配置
 *   node tools/test-external.mjs --keep-session   # 失败时保留上游会话（排障用）
 *
 * 末行输出 `DONE fails=N`。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
// 这两个是**纯模块**（只有 node:crypto / fs，不在模块求值期读 env），
// 所以可以静态引入，不会破坏下面"先在 app 模块之前决定上游"的次序。
// ⚠️ 刻意**不**引 `app/paths.mjs`：它的 `DATA_DIR` 在模块求值期就定死了，
// 而本脚本随后会把 `STI_DATA_DIR` 指到临时目录 —— 用它反而会读到错的那份。
import { loadSecret } from '../app/data/secret.mjs';
import { decryptSecret } from '../app/platform/identity/credentials.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-ext-'));
process.env.STI_DATA_DIR = tmp;
process.env.STI_LOG_LEVEL = 'error';
// 0.21.4：不再有 `STI_KERNEL` 这个开关（内核模式已删）。本脚本要的就是真实内核，
// 而"有没有地址"就是唯一判据 —— 上游解析的结果已写进 DSH_ORIGIN / config。
process.env.STI_RATE_LIMIT = '100000';
process.env.STI_RATE_LIMIT_LOGIN = '100000';   // 登录路由有独立阈值，回归不测它就别被它挡

await import('../app/util/quiet-warnings.mjs');

let total = 0, fails = 0, skips = 0;
const failures = [], skipped = [];
async function t(name, fn) {
  total++;
  try {
    const r = await fn();
    if (r && r.skip) { total--; skips++; skipped.push({ name, reason: r.skip }); console.log('  ~ ' + name); console.log('      跳过：' + r.skip); return; }
    console.log('  \u2713 ' + name);
  } catch (e) {
    fails++; failures.push({ name, error: e });
    console.log('  \u2717 ' + name);
    for (const l of String((e && e.message) || e).split('\n').slice(0, 8)) console.log('      ' + l);
  }
}
const section = (s) => { console.log(''); console.log('── ' + s + ' ' + '─'.repeat(Math.max(0, 56 - s.length))); };

// ── 上游解析（必须在 app 模块之前决定，因为 config 在模块求值期读 env）──────

function resolveUpstream() {
  const envOrigin = process.env.DSH_ORIGIN || '';
  const envToken = process.env.DSH_TOKEN || '';
  if (envOrigin) return { origin: envOrigin, token: envToken, source: 'env' };

  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
    if (j.dshOrigin) {
      let token = String(j.dshToken || '');
      let note = '';
      /**
       * 0.15.0 起，内核接入向导写出去的令牌是**密文**（`dshTokenCipher`）。
       * 不认这一种形状的后果很具体：**恰恰是"已经按推荐方式接好内核"的部署**，
       * 这一套外部验收会永远 SKIP —— 而那正是它最该跑的场合。
       * （它不是理论问题：0.15.0 收口时把开发机上的配置封存成密文，这里当场就 SKIP 了。）
       */
      if (!token && j.dshTokenCipher) {
        try {
          token = decryptSecret(String(j.dshTokenCipher), loadSecret(path.join(ROOT, 'data', '.secret')));
          note = '（令牌来自密文）';
        } catch (e) {
          console.log('  ! data/config.json 里的令牌是密文但解不开：' + e.message);
          console.log('    多半是 data/.secret 被换过 —— 按"没有令牌"继续（会 SKIP）。');
        }
      }
      return { origin: String(j.dshOrigin), token, source: 'data/config.json' + note };
    }
  } catch { /* 未配置 */ }

  if (has('dev-config')) {
    // 开发回退：复用**同级另一个工程**的 DSH 配置（同权利人早期作品）。
    // ⚠️ 刻意不写死那个工程的名字：名字一变这里就悄悄失效。改用
    //    `STI_DEV_CONFIG`（指向任意配置文件）显式指定；未设时按约定取
    //    同级 `dsh-config.json`。取不到就如实 SKIP，不猜。
    const devPath = process.env.STI_DEV_CONFIG
      || path.join(ROOT, '..', 'dsh-config.json');
    try {
      const j = JSON.parse(fs.readFileSync(devPath, 'utf8'));
      if (j.origin) return { origin: String(j.origin), token: String(j.token || ''), source: path.basename(devPath) + '（开发回退）' };
    } catch { /* ignore */ }
  }
  return null;
}

const upstream = resolveUpstream();
if (upstream) {
  process.env.DSH_ORIGIN = upstream.origin;
  process.env.DSH_TOKEN = upstream.token;
}

console.log('');
console.log('STI HARNESS 外部内核端到端回归');
console.log('='.repeat(64));

if (!upstream) {
  console.log('');
  console.log('  未找到可用上游 —— SKIP（不是通过）。');
  console.log('  配置方式：设 DSH_ORIGIN / DSH_TOKEN，或写 data/config.json，');
  console.log('           开发期可加 --dev-config 复用同级工程的配置');
  console.log('           （或用 STI_DEV_CONFIG 显式指向配置文件）。');
  console.log('');
  console.log('DONE fails=0 skipped=1');
  process.exitCode = 0;
  process.exit();
}

console.log('');
console.log('  上游  : ' + upstream.origin + '（来自 ' + upstream.source + '）');

// ── 装配 ──────────────────────────────────────────────────────────────

const { ensureRuntimeDirs, DB_FILE, DATA_DIR } = await import('../app/paths.mjs');
const db = await import('../app/data/db.mjs');
const migrate = await import('../app/data/migrate.mjs');
const { loadConfig } = await import('../app/config.mjs');
const { createIdentityService } = await import('../app/platform/identity/service.mjs');
const { createKnowledgeService } = await import('../app/platform/knowledge/service.mjs');
// 0.21.0 起还必须给出工作区服务：工作区路由在**装配期**就要 deps.workspace。
// ⚠️ 这一项尤其容易忘 —— 它平时靠"上游不在场"自报 SKIP，装配失败却**不会**变成 SKIP，
//    而是抛错退出（末行缺失 → 门禁判"没跑到末尾"）。真上游在场时才会发现它从来没跑起来。
const { createWorkspaceService } = await import('../app/platform/workspace/service.mjs');
const { createGovernanceService } = await import('../app/platform/governance/service.mjs');
const { createOperationService } = await import('../app/platform/operation/service.mjs');
const { createModelService } = await import('../app/platform/model/service.mjs');
const { createScheduleService } = await import('../app/platform/schedule/service.mjs');
const { createNotifyService } = await import('../app/platform/notify/service.mjs');
const { selectKernel } = await import('../app/kernel/index.mjs');
const { createServer } = await import('../app/http/server.mjs');
const audit = await import('../app/platform/governance/audit.mjs');

ensureRuntimeDirs();
db.openDb(DB_FILE);
migrate.migrate();

const config = loadConfig();
const kernel = await selectKernel(config.values);

// 上游不可用就直接 SKIP —— 不装配、不制造假失败
const upStatus = await kernel.provider.status();
if (!upStatus || upStatus.state !== 'ok') {
  console.log('  上游状态: ' + (upStatus ? upStatus.state : '未知') + '｜' + ((upStatus && upStatus.detail) || ''));
  console.log('');
  console.log('  上游当前不可用 —— SKIP（不是通过）。');
  console.log('  排查：地址对不对、令牌是否过期（重新 `dsh web` 取带 ?token= 的地址）。');
  console.log('');
  console.log('DONE fails=0 skipped=1');
  process.exitCode = 0;
  process.exit();
}
console.log('  上游状态: ok｜' + upStatus.detail + '｜版本 ' + (upStatus.version || '—'));

const identity = createIdentityService({ masterSecret: crypto.randomBytes(32), sessionTtlMs: 3600 * 1000 });
const knowledge = createKnowledgeService({ config, audit, resolveCredential: () => null });
// 与 main.mjs 同构装配（见上面的 import 注释）。
const workspace = createWorkspaceService({ identity, audit });
const governance = createGovernanceService();
const { server } = createServer({
  config, kernel, identity, knowledge, workspace, governance,
  operation: createOperationService({ dataDir: DATA_DIR }),
  model: createModelService({}),
  notify: createNotifyService({}),
  schedule: createScheduleService({}),
  paths: { DATA_DIR }, startedAt: Date.now(),
});

await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const BASE = 'http://127.0.0.1:' + server.address().port;

let cookie = null;
async function call(method, p, { json, headers = {} } = {}) {
  const h = { ...headers };
  if (json !== undefined) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  const res = await fetch(BASE + p, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json), redirect: 'manual' });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pair = (sc || []).find((c) => c.startsWith('sti_session='));
  if (pair) cookie = pair.split(';')[0];
  return { status: res.status, body, text };
}

const UNVERIFIED = process.env.STI_ALLOW_UNVERIFIED === '1';
let kernelSessionId = null;
let platformSessionId = null;

/* ── 1. 内核探测 ────────────────────────────────────────────────────── */

section('内核探测：接入状态、版本、垫片');

await t('内核相关接口未登录时按 401 拒绝（不是裸奔）', async () => {
  const r = await call('GET', '/api/kernel/status');
  assert.equal(r.status, 401, '未登录应 401，实际 ' + r.status);
});

await t('平台状态如实报告"内核已接入"与上游状态', async () => {
  const r = await call('GET', '/api/system/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.kernel.ready, true, '本轮回归的**全部意义**就是走真实内核，不能退回测试替身');
  // 令牌只报有没有，不回显
  assert.ok(!('dshToken' in r.body.config.values), '不得回显上游令牌');
});

/* ── 2. 初始化 + 登录 ───────────────────────────────────────────────── */

section('初始化与登录');

await t('初始化向导建组织与所有者账号', async () => {
  const r = await call('POST', '/api/identity/setup', {
    json: {
      orgName: '外部回归组织',
      adminUsername: 'extadmin',
      adminPassword: 'Ext-Adm1n!23',
      adminDisplayName: '外部回归管理员',
    },
  });
  assert.ok(r.status === 200 || r.status === 201, '初始化失败：HTTP ' + r.status + ' ' + r.text.slice(0, 200));
});

await t('登录拿到会话 Cookie', async () => {
  const r = await call('POST', '/api/identity/login', { json: { username: 'extadmin', password: 'Ext-Adm1n!23' } });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.ok(cookie, '未下发会话 Cookie');
});
await t('内核状态可读，且垫片与上游版本**精确**匹配', async () => {
  const r = await call('GET', '/api/kernel/status');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const d = r.body.describe || {};
  assert.equal(d.kernel, 'external');
  assert.equal(d.compatExact, true,
    '垫片与上游版本不匹配：' + (d.compatWarning || '（无告警但 exact 非 true）'));
  assert.ok(d.compatBaseline, '应报出所用垫片版本');
  console.log('      上游 ' + d.kernelVersion + ' ／ 垫片 ' + d.compatBaseline);
});

/* ── 3. 真实能力（模型 / 技能来自上游）──────────────────────────────── */

section('真实能力：模型目录与技能清单来自上游');

await t('模型目录来自上游，且给出可路由供应商', async () => {
  const r = await call('GET', '/api/kernel/models');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const c = r.body.catalog;
  assert.ok(c, '取不到模型目录：' + JSON.stringify(r.body).slice(0, 200));
  assert.ok(Array.isArray(c.groups) && c.groups.length > 0, '模型分组为空');
  assert.ok(c.default && c.default.provider && c.default.model, '缺少默认模型');
  console.log('      默认 ' + c.default.provider + '/' + c.default.model + '，可路由 ' + (c.routableProviders || []).length + ' 个供应商');
});

await t('技能清单走真实 RPC（不是空壳）', async () => {
  const r = await call('GET', '/api/capability/skills');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const items = r.body.items || r.body.skills || [];
  assert.ok(Array.isArray(items), '技能清单形状异常：' + JSON.stringify(r.body).slice(0, 160));
  console.log('      技能 ' + items.length + ' 项（来自上游 skills/list）');
});

/* ── 4. 对话闭环（本脚本的核心）────────────────────────────────────── */

section('对话闭环：建会话 → 发一轮 → 拿回事件');

await t('建会话（上游 session/create）', async () => {
  if (UNVERIFIED) return { skip: 'STI_ALLOW_UNVERIFIED=1，跳过强断言' };
  const r = await call('POST', '/api/kernel/sessions', { json: { cwd: tmp, title: '外部回归会话' } });
  assert.equal(r.status, 201, '建会话失败：' + r.status + ' ' + r.text.slice(0, 300));
  assert.ok(r.body.session && r.body.session.id, '未返回平台会话 id');
  platformSessionId = r.body.session.id;
  kernelSessionId = r.body.session.kernelSessionId;
  assert.ok(kernelSessionId, '未返回内核会话 id');
});

await t('发一轮对话并收集到真实事件（这是"能不能用"的判据）', async () => {
  if (!platformSessionId) return { skip: '会话未建成' };
  const r = await call('POST', `/api/kernel/sessions/${platformSessionId}/turns`, {
    json: { content: '请只回复两个字：收到', mode: 'chat', requestId: 'ext-' + crypto.randomUUID().slice(0, 8) },
  });
  assert.equal(r.status, 200, '提交回合失败：' + r.status + ' ' + r.text.slice(0, 300));
  const b = r.body;
  assert.ok(b.eventsWritten > 0,
    '本轮没有收集到任何事件 —— 对话链路没通。truncated=' + b.truncated + ' warning=' + (b.warning || '无')
    + ' events=' + JSON.stringify((b.events || []).slice(0, 3)).slice(0, 300));
  assert.ok(Array.isArray(b.events) && b.events.length > 0, 'events 为空');
  const types = [...new Set(b.events.map((e) => e.type))];
  console.log('      事件 ' + b.events.length + ' 条，类型：' + types.slice(0, 12).join(' '));
  assert.ok(types.includes('turn-start'), '缺少 turn-start：事件流没有起点，说明映射或来源不对');
  assert.ok(types.some((x) => x === 'turn-end' || x === 'message'), '既没有 turn-end 也没有 message');
});

await t('回合事件真的落库（轨迹/统计的数据源）', async () => {
  if (!platformSessionId) return { skip: '会话未建成' };
  const r = await call('GET', `/api/kernel/sessions/${platformSessionId}/events`);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.ok(r.body.count > 0, '本地库没有事件 —— 落库环节断了');
});

await t('用量采集：有观测就必须有账（不许"模型烧了 token 而账上是 0"）', async () => {
  if (!platformSessionId) return { skip: '会话未建成' };
  const ev = await call('GET', `/api/kernel/sessions/${platformSessionId}/events`);
  assert.equal(ev.status, 200, ev.text.slice(0, 200));
  const rows = ev.body.items || [];
  // ⚠️ 关键：上游**没有独立的 usage 事件**，用量挂在 `assistant/message` 的 `data.usage` 上
  // （契约层 events.mjs 顶部早已写明）。所以"这一轮有没有用量观测"必须这样判 ——
  // 原先这条只写"用量可能为 0（上游未回报 usage 时）"就放过了，
  // 而那句话的前提是**假的**：上游回报了，采集侧却只认 `type === 'usage'`，于是每轮都漏账，
  // 页面显示"累计 tokens 0"。**假前提把真缺陷写成了预期行为** —— 这正是本项目最忌讳的一类。
  const withUsage = rows.filter((e) => e && e.usage && typeof e.usage === 'object');
  const usg = await call('GET', `/api/governance/usage?sessionId=${platformSessionId}`);
  assert.equal(usg.status, 200, usg.text.slice(0, 200));
  const t = usg.body.totals || {};
  const billed = Number(t.input || 0) + Number(t.cacheRead || 0) + Number(t.cacheWrite || 0) + Number(t.output || 0);

  if (!withUsage.length) {
    // 上游这一轮确实没回报用量 → 账上必须是 0（缺就是缺，**不许编数**）
    assert.equal(billed, 0, '事件里没有任何用量观测，账上却有数字 —— 那是编出来的');
    return { skip: '这一轮上游未回报用量（无观测则无账，符合预期）' };
  }
  const observed = withUsage.reduce((a, e) => a
    + Number(e.usage.input || 0) + Number(e.usage.cacheRead || 0)
    + Number(e.usage.cacheWrite || 0) + Number(e.usage.output || 0), 0);
  assert.ok(billed > 0,
    '事件里有真实用量观测（' + observed + ' tokens）而 usage_records 是 0 —— 漏账。'
    + '观测到的记录：' + withUsage.map((e) => e.type + '=' + JSON.stringify(e.usage)).join(' / '));
});

/* ── 5. 清理 ────────────────────────────────────────────────────────── */

if (kernelSessionId && !has('keep-session')) {
  section('清理');
  await t('归档测试会话（上游 workspace/archiveSession）', async () => {
    if (!platformSessionId) return { skip: '无会话' };
    const r = await call('POST', `/api/kernel/sessions/${platformSessionId}/cancel`, { json: {} });
    assert.ok(r.status === 200 || r.status === 404, '取消会话异常：' + r.status);
  });
}

/* ── 收尾 ───────────────────────────────────────────────────────────── */

console.log('');
if (skipped.length) {
  console.log('跳过 ' + skips + ' 条：');
  for (const s of skipped) console.log('  ~ ' + s.name + '：' + s.reason);
}
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  · ' + f.name + '\n    ' + String(f.error.message).split('\n')[0]);
}
console.log('='.repeat(64));
console.log('用例 ' + total + ' 个｜失败 ' + fails + ' 个｜跳过 ' + skips + ' 个');
/**
 * 末行的 `skipped=` **只在"一条用例都没真跑"时出现**（全部走了 SKIP 分支）。
 *
 * 为什么不是"只要有人跳过就带上"：门禁把末行的 `skipped=` 读成"整个检查项未验收"，
 * 于是一轮"14 条里跳了 1 条"会被记成整个外部验收没做 —— 那是**另一种失真**
 * （真实情况是 13 条跑过、1 条没跑）。**部分跳过**由上一行的
 * `跳过 N 个` 如实报出，门禁汇总里也会显示成 "14 用例 / 0 失败 / 1 跳过"。
 * 而 `total === 0` 时**必须**带 `skipped=`：那种情况读起来是"全绿"，实际是一条没验。
 */
console.log('DONE fails=' + fails + (total === 0 && skips > 0 ? ' skipped=' + skips : ''));
process.exitCode = fails ? 1 : 0;
try { server.close(); } catch { /* ignore */ }
setTimeout(() => process.exit(process.exitCode || 0), 300).unref();
