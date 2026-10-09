/**
 * 外部内核「流式回合」验收（P0-C 的真实内核部分）。
 *
 * 与 test-stream.mjs 的分工：
 *   · test-stream.mjs          —— 协议与治理语义（恒用 测试替身，无上游也在场）；
 *   · 本脚本                    —— 真上游下的**增量到达**与端到端可用性。
 *
 * 为什么必须单独跑真上游：测试替身 是"脚本化"的，它的增量节奏由我们自己控制；
 * 真实内核的事件是随时间陆续产出的 —— 只有在这里才能证明"首字先到"不是
 * 我们自己编出来的假象。这是 P0-A/P0-C 的分水岭断言。
 *
 * 需要一台可达且已认证的上游。用法：
 *   DSH_ORIGIN=http://127.0.0.1:3082 DSH_TOKEN=<token> node tools/test-external-stream.mjs
 * 未提供上游时**明确跳过**（打印 SKIP，退出码 0）—— 不假装跑过。
 *
 * 末行输出 `DONE fails=0` 或 `SKIP`。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const UPSTREAM = process.env.DSH_ORIGIN || '';
const TOKEN = process.env.DSH_TOKEN || '';
if (!UPSTREAM || !TOKEN) {
  console.log('');
  console.log('STI HARNESS 外部内核流式验收');
  console.log('='.repeat(64));
  console.log('SKIP：未提供上游（需设置 DSH_ORIGIN 与 DSH_TOKEN）。');
  console.log('      本项**未执行**，不计入通过。');
  console.log('SKIP');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-extstream-'));
process.env.STI_DATA_DIR = tmp;
process.env.STI_LOG_LEVEL = 'error';
// 0.21.4：`STI_KERNEL` 已随内核模式一起删除；有没有地址就是唯一判据（下面写 DSH_ORIGIN）。
process.env.STI_RATE_LIMIT = '100000';
process.env.STI_RATE_LIMIT_LOGIN = '100000';   // 登录路由有独立阈值，回归不测它就别被它挡
process.env.DSH_ORIGIN = UPSTREAM;
process.env.DSH_TOKEN = TOKEN;

await import('../app/util/quiet-warnings.mjs');
const { ensureRuntimeDirs, DB_FILE, DATA_DIR } = await import('../app/paths.mjs');
const db = await import('../app/data/db.mjs');
const migrate = await import('../app/data/migrate.mjs');
const { loadConfig } = await import('../app/config.mjs');
const { createIdentityService } = await import('../app/platform/identity/service.mjs');
const { createKnowledgeService } = await import('../app/platform/knowledge/service.mjs');
const { createGovernanceService } = await import('../app/platform/governance/service.mjs');
const { createOperationService } = await import('../app/platform/operation/service.mjs');
const { createModelService } = await import('../app/platform/model/service.mjs');
const { createScheduleService } = await import('../app/platform/schedule/service.mjs');
const { createNotifyService } = await import('../app/platform/notify/service.mjs');
const { selectKernel } = await import('../app/kernel/index.mjs');
const { createServer } = await import('../app/http/server.mjs');
const audit = await import('../app/platform/governance/audit.mjs');

let total = 0;
let fails = 0;
const failures = [];
async function t(name, fn) {
  total++;
  try {
    const r = await fn();
    if (r && r.skip) { total--; console.log('  ~ ' + name + '\n      跳过：' + r.skip); return; }
    console.log('  \u2713 ' + name);
  } catch (e) {
    fails++;
    failures.push({ name, error: e });
    console.log('  \u2717 ' + name);
    const msg = (e && e.message) ? String(e.message) : String(e);
    for (const line of msg.split('\n').slice(0, 6)) console.log('      ' + line);
  }
}
function section(title) { console.log(''); console.log('── ' + title + ' ' + '─'.repeat(Math.max(0, 56 - title.length))); }

console.log('');
console.log('STI HARNESS 外部内核流式验收（P0-C · 真实上游）');
console.log('='.repeat(64));

ensureRuntimeDirs();
db.openDb(DB_FILE);
migrate.migrate();

const MASTER = crypto.randomBytes(32);
const identity = createIdentityService({ masterSecret: MASTER, sessionTtlMs: 3600 * 1000 });
const config = loadConfig();
const kernel = await selectKernel(config.values);
const knowledge = createKnowledgeService({ config, audit, resolveCredential: () => null });
const governance = createGovernanceService();
const { server } = createServer({
  config, kernel, identity, knowledge, governance,
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
  let body = null; try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, headers: res.headers, body, text };
}

let adminToken = null;
let sessionId = null;

section('装配与真实上游状态');
await t('内核是 external 且上游可达（否则本脚本无意义）', async () => {
  const s = await call('GET', '/api/health');
  assert.equal(s.status, 200);
  // /api/health 是否带内核信息因实现而异；用需要登录的状态接口复核
  const setup = await call('POST', '/api/identity/setup', {
    json: { orgName: '外部流式验收组织', adminUsername: 'extstream', adminPassword: 'Ext-Str3am!23', adminDisplayName: '外部流式验收' },
  });
  assert.ok(setup.status === 200 || setup.status === 201, '初始化失败：' + setup.status + ' ' + setup.text.slice(0, 200));
  const login = await call('POST', '/api/identity/login', { json: { username: 'extstream', password: 'Ext-Str3am!23' } });
  assert.equal(login.status, 200, login.text.slice(0, 200));
  adminToken = login.body.token;

  const st = await call('GET', '/api/system/status');
  assert.equal(st.status, 200);
  assert.equal(st.body.kernel.ready, true, '本脚本必须跑在可达的真实内核上（实际 ready=' + st.body.kernel.ready + '）');
});

await t('建立会话（在上游真建一份）', async () => {
  const r = await call('POST', '/api/kernel/sessions', { token: adminToken, json: { title: '外部流式验收会话' } });
  assert.equal(r.status, 201, r.text.slice(0, 300));
  sessionId = r.body.session.id;
  assert.ok(sessionId);
});

section('流式回合：真实上游的增量到达');

let stats = null;
await t('提交一轮：至少收到 1 条事件，且最后是 turn-end', async () => {
  const res = await fetch(BASE + '/api/kernel/sessions/' + sessionId + '/turns/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken },
    body: JSON.stringify({ content: '请回复两个字：收到' }),
  });
  assert.equal(res.status, 200);
  assert.ok(String(res.headers.get('content-type')).includes('application/x-ndjson'));
  assert.equal(res.headers.get('content-length'), null);

  const dec = new TextDecoder();
  const t0 = Date.now();
  let buf = '';
  let chunkCount = 0;
  let firstEventAt = null;
  let doneAt = null;
  const frames = [];
  for await (const chunk of res.body) {
    chunkCount++;
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const f = JSON.parse(line);
      frames.push(f);
      if (f.kind === 'event' && firstEventAt == null) firstEventAt = Date.now() - t0;
      if (f.kind === 'done') doneAt = Date.now() - t0;
      if (f.kind === 'error') throw new Error('流中报错：' + f.code + ' ' + f.message);
    }
  }
  const events = frames.filter((f) => f.kind === 'event').map((f) => f.event);
  const done = frames.find((f) => f.kind === 'done');
  stats = { chunkCount, eventCount: events.length, firstEventAt, doneAt, done, kinds: frames.map((f) => f.kind) };

  console.log('      事件 ' + events.length + ' 条｜分块 ' + chunkCount
    + '｜首事件 +' + firstEventAt + 'ms｜收流 +' + doneAt + 'ms'
    + '｜类型 ' + [...new Set(events.map((e) => e.type))].join(','));
  assert.ok(events.length >= 1, '真实上游应至少产出 1 条事件');
  assert.equal(events[events.length - 1].type, 'turn-end', '最后一条事件应是 turn-end');
  assert.ok(done, '应收到 done 帧');
});

await t('落库条数与 done 声明一致（真实上游也一样同源）', async () => {
  const r = await call('GET', '/api/kernel/sessions/' + sessionId + '/events?limit=1000', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.count, stats.done.eventsWritten, '库中 ' + r.body.count + ' 条 vs done 声明 ' + stats.done.eventsWritten);
});

await t('增量到达证据：首事件时刻早于收流时刻（不是一次性返回）', async () => {
  // 真实上游里，首事件与收流之间通常有明显间隔；保守断言"早或等于"，
  // 但要求分块数 > 1 —— 一次性返回不可能分多块。
  assert.ok(stats.chunkCount >= 2, '分块数应 > 1（实际 ' + stats.chunkCount + '）');
  assert.ok(stats.firstEventAt != null, '应记录到首事件时刻');
  assert.ok(stats.firstEventAt <= stats.doneAt, '首事件不可能晚于收流');
});

console.log('');
console.log('='.repeat(64));
if (fails) { console.log('失败明细：'); for (const f of failures) console.log('  ✗ ' + f.name + '\n      ' + (f.error && f.error.message)); }
console.log('用例 ' + total + ' 个｜失败 ' + fails + ' 个');
console.log('DONE fails=' + fails);

try { server.close(); } catch { /* ignore */ }
try { db.closeDb && db.closeDb(); } catch { /* ignore */ }
process.exit(fails ? 1 : 0);
