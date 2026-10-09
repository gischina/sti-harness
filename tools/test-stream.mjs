/**
 * 流式回合回归（P0-C 验收）。
 *
 * 为什么单开一个脚本：
 *   流式是**协议级**行为 —— 响应的形状（chunked、无 content-length）、
 *   帧的顺序（meta → turn → event* → done）、中途失败只能靠 error 帧、
 *   以及"客户端断开后已收事件仍要落库"这些**都不是普通 JSON 断言能覆盖的**。
 *   放进 test-http 会让那个脚本同时承担"接口正确性"和"传输语义"两件事。
 *
 * 自包含：自建临时库、随机端口、固定 测试替身 —— 不依赖上游、不占 3090。
 *
 * 用法：node tools/test-stream.mjs
 * 末行输出 `DONE fails=0`。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-stream-'));
process.env.STI_DATA_DIR = tmp;
process.env.STI_LOG_LEVEL = 'error';
// 内核改由下面**显式注入测试替身**（0.21.4 起没有"内核模式"这个开关了）。
process.env.STI_RATE_LIMIT = '100000';
process.env.STI_RATE_LIMIT_LOGIN = '100000';   // 登录路由有独立阈值，回归不测它就别被它挡

await import('../app/util/quiet-warnings.mjs');
const { ensureRuntimeDirs, DB_FILE, DATA_DIR } = await import('../app/paths.mjs');
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
const { createServer } = await import('../app/http/server.mjs');
const { openNdjsonStream } = await import('../app/http/stream.mjs');
const audit = await import('../app/platform/governance/audit.mjs');

let total = 0;
let fails = 0;
let skips = 0;
const failures = [];

async function t(name, fn) {
  total++;
  try {
    const r = await fn();
    if (r && r.skip) { total--; skips++; console.log('  ~ ' + name + '\n      跳过：' + r.skip); return; }
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
console.log('STI HARNESS 流式回合回归（P0-C）');
console.log('='.repeat(64));

/* ── 0. 助手单元：不经过网络，直接证明"每帧一次 write、不内部攒批" ──────── */

section('openNdjsonStream 单元（网络之外）');

/** 造一个够用的假 ServerResponse：只实现助手真正碰到的成员 */
function fakeRes() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.socket = { setNoDelay() {} };
  res.statusCode = 0;
  res.headers = null;
  res.chunks = [];
  res.endCount = 0;
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers; res.headersSent = true; return res; };
  res.write = (s) => { res.chunks.push(String(s)); return true; };
  res.end = () => { res.endCount++; res.writableEnded = true; return res; };
  return res;
}

await t('每调用一次 write 就产生一次 res.write（不内部攒批 → 才叫流式）', () => {
  const res = fakeRes();
  const s = openNdjsonStream({ res, requestId: 'req_test' }, { heartbeatMs: 0 });
  s.meta({ sessionId: 'x' });
  s.event({ type: 'turn-start' });
  s.event({ type: 'turn-end' });
  s.done({ eventsWritten: 1 });
  assert.equal(res.chunks.length, 4, '4 次调用应产生 4 次 res.write，实际 ' + res.chunks.length);
  assert.equal(res.statusCode, 200);
  assert.ok(String(res.headers['content-type']).includes('application/x-ndjson'));
  // 关掉 nginx 缓冲是流式能否成立的关键头，少了它生产环境会退化成"整轮返回"
  assert.equal(res.headers['x-accel-buffering'], 'no');
  // 每一帧都必须以换行结尾（帧分隔符），否则客户端无法切行
  for (const c of res.chunks) assert.ok(c.endsWith('\n'), '每帧必须以 \\n 结尾');
  s.close();
  assert.equal(res.endCount, 1, 'close 只结束一次');
});

await t('close 幂等；close 之后的 write 是空操作（不往死连接写）', () => {
  const res = fakeRes();
  const s = openNdjsonStream({ res, requestId: 'req_test' }, { heartbeatMs: 0 });
  s.event({ type: 'a' });
  s.close();
  s.close();
  assert.equal(res.endCount, 1);
  assert.equal(s.write({ x: 1 }), false, '已关闭时 write 应返回 false');
  assert.equal(res.chunks.length, 1, '关闭后不得再写入');
});

await t('响应已开始写出时拒绝切换为流式（防"半截 JSON + 半截流"）', () => {
  const res = fakeRes();
  res.headersSent = true;
  assert.throws(() => openNdjsonStream({ res, requestId: 'r' }), /无法切换为流式/);
});

/* ── 装配 ────────────────────────────────────────────────────────── */

ensureRuntimeDirs();
db.openDb(DB_FILE);
migrate.migrate();

const MASTER = crypto.randomBytes(32);
const identity = createIdentityService({ masterSecret: MASTER, sessionTtlMs: 3600 * 1000 });
const config = loadConfig();
// 显式注入测试替身：产品路径上没有"没配地址也能用"的内核（那层降级已删）。
const kernel = createKernel({ provider: createKernelStub(), reason: '回归用测试替身（不依赖真实内核）' });
const knowledge = createKnowledgeService({ config, audit, resolveCredential: () => null });
// 与 main.mjs 同构装配。本套回归不测工作区，但它必须在场（见上面的 import 注释）。
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
const PORT = server.address().port;
const BASE = 'http://127.0.0.1:' + PORT;

async function call(method, p, { token, json, raw = false } = {}) {
  const h = {};
  if (json !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json), redirect: 'manual' });
  if (raw) return res;
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, headers: res.headers, body, text };
}

let adminToken = null;
let sessionId = null;

const ADMIN = { username: 'streamadmin', password: 'Str3am-Adm!n' };

await t('初始化向导建组织与管理员', async () => {
  const r = await call('POST', '/api/identity/setup', {
    json: { orgName: '流式回归组织', adminUsername: ADMIN.username, adminPassword: ADMIN.password, adminDisplayName: '流式回归管理员' },
  });
  assert.ok(r.status === 200 || r.status === 201, '初始化失败：HTTP ' + r.status + ' ' + r.text.slice(0, 200));
});

await t('登录拿到令牌', async () => {
  const r = await call('POST', '/api/identity/login', { json: ADMIN });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  adminToken = r.body.token;
  assert.ok(adminToken, '登录响应应带 token');
});

/* ── 1. 未授权 / 前置校验必须回 JSON（而不是流） ──────────────────── */

section('前置校验：开流之前的失败必须仍是正常 HTTP 语义');

await t('未登录提交流式回合 → 401 JSON（不是 200 的流）', async () => {
  const res = await call('POST', '/api/kernel/sessions/nope/turns/stream', { json: { content: 'hi' }, raw: true });
  assert.equal(res.status, 401);
  assert.ok(String(res.headers.get('content-type')).includes('application/json'), '未授权不应返回 ndjson');
});

await t('不存在的会话 → 404 JSON（校验在开流之前）', async () => {
  const r = await call('POST', '/api/kernel/sessions/no-such-session/turns/stream', { token: adminToken, json: { content: 'hi' } });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
});

await t('建立会话用于后续流式用例', async () => {
  const r = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '流式回归会话' } });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  sessionId = r.body.session.id;
  assert.ok(sessionId);
});

await t('content 为空 → 400 JSON（同样在开流之前拦下）', async () => {
  const r = await call('POST', '/api/kernel/sessions/' + sessionId + '/turns/stream', { token: adminToken, json: { content: '   ' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'bad_request');
});

/* ── 2. 读一个 NDJSON 流（客户端侧的真实解析路径） ─────────────────── */

/**
 * 发一次流式提交并逐块读回。
 * 返回：状态、响应头、原始分块数、按行解析出的帧数组、原始文本。
 */
async function streamTurn(content) {
  const res = await fetch(BASE + '/api/kernel/sessions/' + sessionId + '/turns/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken },
    body: JSON.stringify({ content }),
  });
  const dec = new TextDecoder();
  let buf = '';
  let chunkCount = 0;
  let rawText = '';
  const frames = [];
  for await (const chunk of res.body) {
    chunkCount++;
    const s = dec.decode(chunk, { stream: true });
    rawText += s;
    buf += s;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      frames.push(JSON.parse(line));
    }
  }
  return { status: res.status, headers: res.headers, chunkCount, frames, rawText };
}

section('流式回合：帧协议与落库一致性');

let streamResult = null;

await t('提交一轮 → 200 / application/x-ndjson / chunked（无 content-length）', async () => {
  streamResult = await streamTurn('流式你好');
  assert.equal(streamResult.status, 200);
  assert.ok(String(streamResult.headers.get('content-type')).includes('application/x-ndjson'), '内容类型应为 ndjson');
  // 没有 content-length = 服务端事先不知道总长 = 真的是边算边发（而不是攒完再发一个整包）
  assert.equal(streamResult.headers.get('content-length'), null, '流式响应不应带 content-length');
});

await t('帧顺序：meta → turn → event* → done（且 turn-end 是最后一条事件）', async () => {
  const kinds = streamResult.frames.map((f) => f.kind);
  assert.equal(kinds[0], 'meta');
  assert.equal(kinds[1], 'turn');
  assert.equal(kinds[kinds.length - 1], 'done');
  assert.ok(kinds.includes('event'), '应有 event 帧');
  const events = streamResult.frames.filter((f) => f.kind === 'event').map((f) => f.event);
  assert.ok(events.length >= 6, '测试替身 一轮脚本至少 6 条事件，实际 ' + events.length);
  assert.equal(events[events.length - 1].type, 'turn-end', '最后一条事件应是 turn-end');
  // 事件必须带 seq 且单调递增 —— 前端据此增量归并，错乱会让界面乱序
  let last = -Infinity;
  for (const e of events) { assert.ok(Number(e.seq) > last, 'seq 必须严格递增'); last = Number(e.seq); }
});

await t('done 帧的 eventsWritten 与库中事件数一致（流式与落库同源）', async () => {
  const done = streamResult.frames.find((f) => f.kind === 'done');
  assert.ok(done, '缺少 done 帧');
  assert.equal(done.truncated, false, '测试替身 下不应截断');
  const events = streamResult.frames.filter((f) => f.kind === 'event');
  assert.equal(done.eventsWritten, events.length, 'done 声明的条数应等于推出去的 event 帧数');

  const r = await call('GET', '/api/kernel/sessions/' + sessionId + '/events?limit=500', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.count, done.eventsWritten, '落库条数应与 done 声明一致');
});

await t('增量到达：分块数 > 1（不是攒成一整包再发）', async () => {
  // meta/turn 两帧紧挨着可能被合并，但事件之间按 STI_STUB_PACE_MS 有间隔，
  // 因此客户端必然观察到多次分块。>= 2 是保守下界。
  assert.ok(streamResult.chunkCount >= 2, '分块数应 > 1（实际 ' + streamResult.chunkCount + '）');
});

await t('用量采集在流式路径同样生效（与一次性接口同源）', async () => {
  const done = streamResult.frames.find((f) => f.kind === 'done');
  assert.ok(done.usageCollected, 'done 应带回用量采集结果');
  assert.equal(done.usageCollected.error, null, '测试替身 下用量采集不应报错：' + JSON.stringify(done.usageCollected));
  assert.ok(done.usageCollected.written >= 1, '测试替身 脚本含 1 条 usage 事件，应采集到 ≥1');
});

await t('产物留存字段在流式路径同样如实带回（即使本轮没有文件）', async () => {
  const done = streamResult.frames.find((f) => f.kind === 'done');
  assert.ok(done.artifactsRecorded, 'done 应带回产物留存结果');
  assert.equal(done.artifactsRecorded.error, null);
});

/* ── 3. 治理闸对流式路由同样生效（治理不因换传输而旁路） ───────────── */

section('会话级模型选择：契约有 selectModel，HTTP 入口也必须真存在');

await t('为会话选择模型 → 200，且如实回带所选 provider/model', async () => {
  const r = await call('POST', '/api/kernel/sessions/' + sessionId + '/model', {
    token: adminToken,
    json: { provider: 'stub', model: 'stub-deterministic' },
  });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.body.model, 'stub-deterministic');
  assert.equal(r.body.provider, 'stub');
});

await t('选择模型缺少 model → 400（不能静默成功）', async () => {
  const r = await call('POST', '/api/kernel/sessions/' + sessionId + '/model', { token: adminToken, json: {} });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'bad_request');
});

await t('选择模型缺少 provider → 400（上游只认**非空**的 provider+model，缺一个整个请求就被拒）', async () => {
  // 2026-10-08 对着运行中的上游实测：给 `provider: null`、缺 provider、缺 model 三种都得到
  // **同一句** `gateway/input-invalid wire field "request" failed boundary validation` ——
  // 那句话不点名字段，线上排障极易误判成"上游挂了"。所以本平台必须在自己的边界上说人话。
  const r = await call('POST', '/api/kernel/sessions/' + sessionId + '/model', {
    token: adminToken, json: { model: 'stub-deterministic' },
  });
  assert.equal(r.status, 400, r.text.slice(0, 200));
  assert.equal(r.body.error.code, 'bad_request');
  assert.ok(/provider/.test(r.body.error.message), '消息里要点名缺的是 provider：' + r.body.error.message);
});

await t('建会话时给了 model 却没给 provider → 400，且**不留空壳**（库里不多出会话行）', async () => {
  // 这条钉的是 0.21.9 之前的线上形态：校验放在建会话**之后** → 上游已经建了一个会话、
  // 本机也写了一条行，响应却是 500 —— 用户读到"新建失败"，库里却多了空壳。
  const before = (await call('GET', '/api/kernel/sessions?limit=200', { token: adminToken })).body.items.length;
  const r = await call('POST', '/api/kernel/sessions', {
    token: adminToken, json: { title: '空壳探测', model: 'stub-deterministic' },
  });
  assert.equal(r.status, 400, r.text.slice(0, 200));
  assert.ok(/provider/.test(r.body.error.message), '消息里要点名缺的是 provider');
  const after = (await call('GET', '/api/kernel/sessions?limit=200', { token: adminToken })).body.items.length;
  assert.equal(after, before, '拦住之后不该多出会话行（该拦在建会话之前）');
});

await t('未登录选择模型 → 401', async () => {
  const r = await call('POST', '/api/kernel/sessions/' + sessionId + '/model', { json: { model: 'x' } });
  assert.equal(r.status, 401);
});

/* ── 4. 配额闸对流式路由同样生效（治理不因换传输而旁路） ───────────── */

section('治理一致性：配额闸不因流式而旁路');

await t('建 turns/day 上限=1 的阻断配额（此前本轮已用 ≥1 轮 → 立即超限）', async () => {
  // ⚠️ 契约规定 limitValue 必须 > 0（0 是非法值）—— 想测"阻断"，就让已用量先达标。
  const r = await call('POST', '/api/governance/quotas', {
    token: adminToken,
    json: { subjectType: 'tenant', metric: 'turns', period: 'day', limitValue: 1, mode: 'block' },
  });
  assert.ok(r.status === 200 || r.status === 201, r.text.slice(0, 200));
});

await t('配额阻断时：流式路由回 403 JSON（且不进入流）', async () => {
  const before = await call('GET', '/api/kernel/sessions/' + sessionId + '/events?limit=500', { token: adminToken });
  const res = await call('POST', '/api/kernel/sessions/' + sessionId + '/turns/stream', { token: adminToken, json: { content: '应被拦' }, raw: true });
  assert.equal(res.status, 403);
  assert.ok(String(res.headers.get('content-type')).includes('application/json'), '被治理拦截时应回 JSON 而不是 ndjson');
  const body = await res.json();
  assert.equal(body.error.code, 'quota_blocked');
  // 铁证：被拦下就不该产生任何新事件（配额闸站在执行之前）
  const after = await call('GET', '/api/kernel/sessions/' + sessionId + '/events?limit=500', { token: adminToken });
  assert.equal(after.body.count, before.body.count, '被配额拦下的回合不得产生事件');
});

await t('解绑阻断配额（恢复现场）', async () => {
  const list = await call('GET', '/api/governance/quotas', { token: adminToken });
  const q = (list.body.items || []).find((x) => x.metric === 'turns' && x.mode === 'block');
  if (!q) return { skip: '未找到刚建的配额' };
  const r = await call('DELETE', '/api/governance/quotas/' + q.id, { token: adminToken });
  assert.ok(r.status === 200 || r.status === 204, r.text.slice(0, 200));
});

/* ── 5. 客户端断开：已收到的事件仍要落库 ───────────────────────────── */

section('断线健壮性：客户端中途断开，已收事件仍落库');

await t('中途 abort 请求后，服务端已收事件不丢（宁缺毋滥，但不整轮丢）', async () => {
  const before = await call('GET', '/api/kernel/sessions/' + sessionId + '/events?limit=2000', { token: adminToken });
  const ac = new AbortController();
  const res = await fetch(BASE + '/api/kernel/sessions/' + sessionId + '/turns/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken },
    body: JSON.stringify({ content: '断线样本' }),
    signal: ac.signal,
  });
  const reader = res.body.getReader();
  // 读到第一块就立刻断开，模拟用户关页面
  await reader.read();
  ac.abort();
  try { await reader.cancel(); } catch { /* 已中止 */ }

  // 给服务端一点时间在断线后完成落库（它此刻正在把已收事件写库）
  await new Promise((r) => setTimeout(r, 400));
  const after = await call('GET', '/api/kernel/sessions/' + sessionId + '/events?limit=2000', { token: adminToken });
  assert.ok(after.body.count > before.body.count, '断开前已收到的事件必须落库（' + before.body.count + ' → ' + after.body.count + '）');
});

/* ── 汇总 ────────────────────────────────────────────────────────── */

console.log('');
console.log('='.repeat(64));
if (skips) console.log('跳过 ' + skips + ' 条');
if (fails) {
  console.log('失败明细：');
  for (const f of failures) console.log('  ✗ ' + f.name + '\n      ' + (f.error && f.error.message));
}
console.log('用例 ' + total + ' 个｜失败 ' + fails + ' 个' + (skips ? '｜跳过 ' + skips + ' 个' : ''));
console.log('DONE fails=' + fails);

try { server.close(); } catch { /* ignore */ }
try { db.closeDb && db.closeDb(); } catch { /* ignore */ }
process.exit(fails ? 1 : 0);
