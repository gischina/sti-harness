/**
 * 检索性能基准 —— 回答验收标准 ①：「10 万 chunk 规模下混合检索 P95 实测」。
 *
 * 为什么要有这个脚本：
 *   roadmap 的验收标准写的是"**实测** P95"，不是"很快"。没有这个脚本，
 *   性能就只能靠嘴说；有了它，任何一个数字都能被重跑复现，也能看出回归。
 *
 * 诚实边界（**必须原样引用到文档里**，别把合成数据的结论当生产结论）：
 *   1. 语料是**合成**的中文文本，不是真实企业资料 —— 它衡量的是**规模**下的
 *      扫描/索引开销，不是真实语料的词分布;
 *   2. 向量是**确定性伪随机**造的（按"主题方向 + 噪声"生成），不是真实 embedding。
 *      所以向量那条线衡量的是**暴力扫描 + 余弦的开销**，不是语义质量；
 *   3. 查询向量由一个本机 stub 服务返回（真 HTTP 往返），所以总耗时里包含一次
 *      本地 embedding 往返（约 1 ms 量级），**不代表真实模型服务的延迟**。
 *      真实模型延迟取决于你接的供应商，不取决于本脚本。
 *   4. 阶段 ⑤ 的「召回重合度」是**合成语料 + 合成向量**下的读数：它能说明
 *      "预过滤会改变哪些结果、丢多少条"这个**机制**，但**不能**当作真实语料下的召回率。
 *      真实召回要在真实语料 + 真实向量上量；这里的价值是"这件事被量过、且可重跑"。
 *
 * 五个阶段：
 *   ① 文本路径（FTS5 + bm25 + bigram）  ② 向量路径（暴力扫描 + 点积）
 *   ③ 服务层混合检索（含一次 embedding 往返）
 *   ④ 正确性抽检 + 算法回归守卫（防"快"来自空转）
 *   ⑤ **向量预过滤对照（B2）**：同一批查询跑 prefilter=false / true 两次，
 *      同时量**延迟**与**召回重合度** —— 只报"快了几倍"而不报"丢了什么"是做了一半。
 *
 * 用法：
 *   node tools/bench-search.mjs                      # 默认 10 万 chunk / 256 维
 *   node tools/bench-search.mjs --chunks=200000 --dim=768
 *   node tools/bench-search.mjs --no-embed           # 只测两路检索器，不起 stub
 *   node tools/bench-search.mjs --repeats=60         # 每个查询重复次数（样本量）
 *   node tools/bench-search.mjs --json                # 末行输出 JSON，便于写入文档
 *
 * 末行输出 `DONE fails=N`（与其它回归脚本一致；有基准断言不达标才算 fails）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

/* ── 参数 ──────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : def;
};
const has = (name) => argv.includes('--' + name);

const CHUNKS = Number(flag('chunks', 100000));
const DIM = Number(flag('dim', 256));
const REPEATS = Number(flag('repeats', 40));
const LIMIT = Number(flag('limit', 10));
const NO_EMBED = has('no-embed');
const AS_JSON = has('json');

/* ── 环境：必须在 import 应用模块之前设定 ───────────────────────── */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-bench-'));
process.env.STI_DATA_DIR = path.join(tmp, 'data');
// 内核改由下面**显式注入测试替身**（0.21.4 起没有"内核模式"这个开关了）。
process.env.STI_WORKERS = '1';           // 基准只用主线程，避免 worker 抢 CPU
process.env.STI_EMBED_PROVIDER = '';     // 先关掉，等 stub 起来再改

await import('../app/util/quiet-warnings.mjs');
const db = await import('../app/data/db.mjs');
const { migrate } = await import('../app/data/migrate.mjs');
const { ensureRuntimeDirs, DATA_DIR } = await import('../app/paths.mjs');
const { loadConfig } = await import('../app/config.mjs');
const { toIndexText } = await import('../app/util/bigram.mjs');
const { createKnowledgeService } = await import('../app/platform/knowledge/service.mjs');
const audit = await import('../app/platform/governance/audit.mjs');
const basesRepo = await import('../app/platform/knowledge/repos/bases.mjs');
const docsRepo = await import('../app/platform/knowledge/repos/documents.mjs');
const { vecToBlob } = await import('../app/platform/knowledge/repos/chunks.mjs');
const { searchFts } = await import('../app/platform/knowledge/retrievers/fts.mjs');
const { searchVector } = await import('../app/platform/knowledge/retrievers/vector.mjs');

ensureRuntimeDirs();

/* ── 本机 stub 向量服务（真 HTTP，但不是真模型） ─────────────────── */

const TOPICS = 32;           // 合成语料的"主题"数
const NEEDLES = 50;          // 稀有词的篇数（用来验证真的检索到了，而不是快得没查）

/** 确定性伪随机：同一个 seed 在任何机器上都得到同一组向量 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function unit(vec) {
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n) || 1;
  return vec.map((v) => v / n);
}

/** 主题方向基向量（确定性） */
const TOPIC_BASE = Array.from({ length: TOPICS + NEEDLES }, (_, t) => {
  const r = rng(1000 + t * 7919);
  return unit(Array.from({ length: DIM }, () => r() * 2 - 1));
});

const NEEDLE_TERM = (n) => '奇特点编号A' + String(n).padStart(2, '0');

let stubServer = null;
let stubPort = 0;

async function startStubEmbedding() {
  stubServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!/\/embeddings$/.test(req.url || '')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stub: 只实现 /embeddings' } }));
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* 下面按缺字段处理 */ }
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input == null ? '' : parsed.input];
      // 确定性"向量"：按查询文本的字符 hash 选一个主题方向 + 噪声，L2 归一化
      const data = inputs.map((text, idx) => {
        const s = String(text == null ? '' : text);
        let h = 0;
        for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
        const base = TOPIC_BASE[(h + idx) % TOPIC_BASE.length];
        const r = rng(h || 1);
        const emb = unit(base.map((v) => v * 0.95 + (r() * 2 - 1) * 0.12));
        return { index: idx, embedding: emb };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data, model: 'bench-stub', usage: { prompt_tokens: 1, total_tokens: 1 } }));
    });
  });
  await new Promise((r) => stubServer.listen(0, '127.0.0.1', r));
  stubPort = stubServer.address().port;
}

/* ── 造语料 ────────────────────────────────────────────────────── */

const WORDS = [
  '空间参考系', '地理信息', '数据治理', '权限管理', '精度说明', '要素分类',
  '元数据', '服务目录', '坐标系', '投影参数', '矢量切片', '栅格影像',
  '成果质检', '作业规范', '变更留痕', '安全分级', '数据血缘', '授权矩阵',
];

function makeBody(i) {
  const r = rng(0x9e3779b9 ^ i);
  const parts = [];
  for (let k = 0; k < 24; k++) parts.push(WORDS[Math.floor(r() * WORDS.length)]);
  const head = '第 ' + (i + 1) + ' 段：';
  return head + parts.join('，') + '。本条记录用于规模基准测试，编号 T' + i + '。';
}

/* ── 主流程 ────────────────────────────────────────────────────── */

const report = {
  machine: {
    platform: process.platform + ' ' + process.arch,
    cpu: (os.cpus()[0] || {}).model || '未知',
    cores: os.cpus().length,
    memGB: Math.round(os.totalmem() / 1073741824 * 10) / 10,
    node: process.versions.node,
    sqlite: 'node:sqlite',
  },
  corpus: { chunks: CHUNKS, dim: DIM, topics: TOPICS, needles: NEEDLES, bodyChars: makeBody(0).length },
  embedding: { mode: NO_EMBED ? 'off' : 'openai-compat(stub, 本机 HTTP)', note: '合成向量，衡量扫描开销，不代表真实模型' },
  ingest: {},
  latency: {},
  recall: {},
};

console.log('');
console.log('STI HARNESS 检索性能基准');
console.log('='.repeat(72));
console.log('机器      ' + report.machine.cpu + ' · ' + report.machine.cores + ' 核 · '
  + report.machine.memGB + ' GB · ' + report.machine.platform + ' · Node ' + report.machine.node);
console.log('规模      ' + CHUNKS.toLocaleString('en-US') + ' 个 chunk × ' + DIM + ' 维向量（合成语料，约 '
  + report.corpus.bodyChars + ' 字/块）');

if (!NO_EMBED) await startStubEmbedding();

db.openDb();
migrate();

// embedding 环境必须在 loadConfig() 之前设置
if (!NO_EMBED) {
  process.env.STI_EMBED_PROVIDER = 'openai-compat';
  process.env.STI_EMBED_BASE_URL = 'http://127.0.0.1:' + stubPort + '/v1';
  process.env.STI_EMBED_MODEL = 'bench-stub';
  process.env.STI_EMBED_DIM = String(DIM);
  process.env.STI_EMBED_CREDENTIAL = 'bench';
}
const config = loadConfig();
const TENANT = 'org_bench';

const knowledge = createKnowledgeService({
  config, audit,
  resolveCredential: () => 'bench-key',
});

const base = basesRepo.createBase({ tenantId: TENANT, name: '基准语料库', dim: NO_EMBED ? 0 : DIM });
const KB = base.id;

/* ── 灌数据 ────────────────────────────────────────────────────── */

const DOCS = 200;                                   // 200 篇文档，均匀分摊 chunk
const perDoc = Math.ceil(CHUNKS / DOCS);
const docIds = [];
for (let d = 0; d < DOCS; d++) {
  const doc = docsRepo.createDocument({
    kbId: KB, title: '基准文档 ' + String(d + 1).padStart(3, '0') + '.md',
    mime: 'text/markdown', size: 0, sha256: 'bench' + d,
    sourceType: 'file', sourceRef: 'bench-' + d + '.md', status: 'ready',
  });
  docIds.push(doc.id);
}

const tIngest0 = performance.now();
let inserted = 0;
const BATCH = 2000;

while (inserted < CHUNKS) {
  const n = Math.min(BATCH, CHUNKS - inserted);
  const startId = inserted;
  const rowIds = db.tx(() => {
    const ids = [];
    for (let k = 0; k < n; k++) {
      const i = startId + k;
      const docId = docIds[Math.min(DOCS - 1, Math.floor(i / perDoc))];
      // 前 NEEDLES 条塞一个只此一处出现的稀有词，用来验证"真的检索到了"
      const body = i < NEEDLES
        ? makeBody(i) + ' 特别标注：' + NEEDLE_TERM(i) + ' 仅此一处出现。'
        : makeBody(i);
      const meta = JSON.stringify({
        heading: '基准章节 ' + (i % 12),
        headingPath: ['基准文档', '基准章节 ' + (i % 12)],
        locationKnown: true,
        charStart: 0, charEnd: 0,
      });
      const r = db.run(
        `INSERT INTO chunks (doc_id, kb_id, ord, body, bigrams, meta_json, token_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [docId, KB, k, body, toIndexText(body), meta, Math.ceil(body.length / 2)]
      );
      ids.push(Number(r.lastInsertRowid));
    }
    return ids;
  });

  if (!NO_EMBED) {
    db.tx(() => {
      for (let k = 0; k < n; k++) {
        const i = startId + k;
        const topic = i < NEEDLES ? TOPICS + i : i % TOPICS;
        const r = rng(0x51ed2701 ^ i);
        const vec = unit(TOPIC_BASE[topic].map((v) => v * 0.97 + (r() * 2 - 1) * 0.1));
        db.run('INSERT INTO chunk_vectors (chunk_id, dim, vec) VALUES (?, ?, ?)',
          [rowIds[k], DIM, vecToBlob(vec)]);
      }
    });
  }
  inserted += n;
}
const ingestMs = performance.now() - tIngest0;

for (let d = 0; d < DOCS; d++) {
  const actual = Math.max(0, Math.min(perDoc, CHUNKS - d * perDoc));
  docsRepo.finishDocument(docIds[d], { chunkCount: actual });
}

const info = db.dbInfo();
const chunkCount = db.get('SELECT COUNT(*) AS n FROM chunks', []).n;
const vecCount = db.get('SELECT COUNT(*) AS n FROM chunk_vectors', []).n;

report.ingest = {
  ms: Math.round(ingestMs),
  chunksPerSec: Math.round(CHUNKS / (ingestMs / 1000)),
  chunks: chunkCount,
  vectors: vecCount,
  dbBytes: info.bytes || null,
};
console.log('入库      ' + Math.round(ingestMs / 1000) + ' s（' + report.ingest.chunksPerSec
  + ' chunk/s）｜chunk ' + chunkCount + ' 行｜向量 ' + vecCount + ' 行｜库文件 '
  + (info.bytes ? (info.bytes / 1048576).toFixed(1) + ' MB' : '未报告'));

/* ── 计时工具 ──────────────────────────────────────────────────── */

function percentiles(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  return {
    n: s.length,
    min: +s[0].toFixed(2),
    p50: +at(50).toFixed(2),
    p90: +at(90).toFixed(2),
    p95: +at(95).toFixed(2),
    p99: +at(99).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
  };
}

/* ── 查询集 ────────────────────────────────────────────────────── */

const QUERIES = [
  { q: '空间参考系', kind: 'long' },
  { q: '数据治理', kind: 'long' },
  { q: '权限管理', kind: 'long' },
  { q: '精度说明', kind: 'long' },
  { q: '管理权限', kind: 'long' },   // 换序（bigram AND 会 0 命中的那个反例）
  { q: '数据', kind: 'short' },
  { q: '权限', kind: 'short' },
  { q: '精度', kind: 'short' },
  { q: '空间', kind: 'short' },
  { q: NEEDLE_TERM(0), kind: 'needle' },
  { q: NEEDLE_TERM(7), kind: 'needle' },
];

/* ── ① 文本路径（FTS5 + bm25 + bigram） ────────────────────────── */

console.log('');
console.log('① 文本检索 searchFts（bm25 + 中文 bigram）');

const ftsSamples = [];
const ftsByMode = new Map();
const ftsHit = new Map();
for (const { q, kind } of QUERIES) {
  const local = [];
  let mode = 'none';
  let hits = 0;
  for (let i = 0; i < REPEATS; i++) {
    const t0 = performance.now();
    const r = searchFts({ tenantId: TENANT, kbIds: [KB], query: q, limit: LIMIT * 3 });
    local.push(performance.now() - t0);
    mode = r.matchMode;
    hits = r.items.length;
  }
  ftsSamples.push(...local);
  report.latency['fts_' + kind + ':' + q] = percentiles(local);
  report.latency['fts_' + kind + ':' + q].matchMode = mode;
  report.latency['fts_' + kind + ':' + q].hits = hits;
  ftsHit.set(q, { mode, hits });
  if (!ftsByMode.has(mode)) ftsByMode.set(mode, []);
  ftsByMode.get(mode).push(...local);
  console.log('  ' + String(q).padEnd(16) + String(mode).padEnd(12)
    + '命中 ' + String(hits).padStart(3) + '  P50 ' + percentiles(local).p50.toFixed(2).padStart(7)
    + ' ms  P95 ' + percentiles(local).p95.toFixed(2).padStart(7) + ' ms');
}
report.latency.fts_all = percentiles(ftsSamples);
for (const [mode, arr] of ftsByMode) report.latency['fts_mode_' + mode] = percentiles(arr);

/* ── ② 向量路径（暴力扫描 + 点积） ─────────────────────────────── */

if (!NO_EMBED) {
  console.log('');
  console.log('② 向量检索 searchVector（暴力扫描 ' + vecCount.toLocaleString('en-US') + ' 条 × ' + DIM + ' 维，L2 归一化后点积）');
  const vecSamples = [];
  for (const { q, kind } of QUERIES) {
    const qv = TOPIC_BASE[kind === 'needle' ? TOPICS + Number(String(q).slice(-2)) : 1];
    const local = [];
    let scanned = 0;
    for (let i = 0; i < REPEATS; i++) {
      const t0 = performance.now();
      const r = searchVector({ tenantId: TENANT, kbIds: [KB], queryVec: qv, limit: LIMIT * 3 });
      local.push(performance.now() - t0);
      scanned = r.scanned;
    }
    vecSamples.push(...local);
    report.latency['vector_' + kind + ':' + q] = percentiles(local);
    report.latency['vector_' + kind + ':' + q].scanned = scanned;
    console.log('  ' + String(q).padEnd(16) + '扫描 ' + String(scanned).padStart(7)
      + '  P50 ' + percentiles(local).p50.toFixed(2).padStart(7)
      + ' ms  P95 ' + percentiles(local).p95.toFixed(2).padStart(7) + ' ms');
  }
  report.latency.vector_all = percentiles(vecSamples);
}

/* ── ③ 服务层混合检索（含一次本机 embedding 往返） ─────────────── */

if (!NO_EMBED) {
  console.log('');
  console.log('③ 服务层混合检索 knowledge.search（两路 + RRF 融合 + 引用溯源，含一次本机 stub embedding 往返）');
  const hySamples = [];
  for (const { q, kind } of QUERIES) {
    const local = [];
    let mode = '';
    let returned = 0;
    let ftsMs = 0;
    let vecMs = 0;
    for (let i = 0; i < REPEATS; i++) {
      const t0 = performance.now();
      const r = await knowledge.search({ tenantId: TENANT, query: q, limit: LIMIT, kbIds: [KB] });
      local.push(performance.now() - t0);
      mode = r.retrieval.mode;
      returned = r.stats.returned;
      ftsMs = r.retrieval.timings.ftsMs;
      vecMs = r.retrieval.timings.vectorMs;
    }
    hySamples.push(...local);
    report.latency['hybrid_' + kind + ':' + q] = percentiles(local);
    Object.assign(report.latency['hybrid_' + kind + ':' + q], { mode, returned, ftsMs, vectorMs: vecMs });
    console.log('  ' + String(q).padEnd(16) + String(mode).padEnd(8)
      + '返回 ' + String(returned).padStart(3) + '  P50 ' + percentiles(local).p50.toFixed(2).padStart(7)
      + ' ms  P95 ' + percentiles(local).p95.toFixed(2).padStart(7)
      + ' ms（内部 fts ' + ftsMs + ' ms / 向量 ' + vecMs + ' ms）');
  }
  report.latency.hybrid_all = percentiles(hySamples);
}

/* ── ④ 正确性抽检 + 算法回归守卫 ───────────────────────────────── */

console.log('');
console.log('④ 正确性抽检（防止"快"来自空转）与算法回归守卫');

let recallFails = 0;
function check(name, ok, detail) {
  console.log('  ' + (ok ? '\u2713' : '\u2717') + ' ' + name + (detail ? '  ' + detail : ''));
  if (!ok) recallFails++;
}

for (const n of [0, 7]) {
  const term = NEEDLE_TERM(n);
  const r = searchFts({ tenantId: TENANT, kbIds: [KB], query: term, limit: 10 });
  const top = r.items[0];
  check('稀有词 ' + term + ' 必须排第 1（FTS）',
    !!top && String(top.body || '').includes(term),
    '模式 ' + r.matchMode + '｜命中 ' + r.items.length);
}

/**
 * 算法回归守卫：**只有当查询代价取决于"命中数"而不是"库内总量"时，稀有词才会这么快。**
 *
 * 背景（这个是真实踩过的坑）：FTS 的 SELECT 早先写成普通 `JOIN chunks`，SQLite 就会
 * 先按 kb_id 扫出**库内全部 chunk** 再逐条回查 FTS 虚拟表 —— 代价变成 O(库内分块数)：
 * 5 万 chunk 时罕见词（1 条命中）要 299 ms、常见词要 1150 ms，罕见词反而更慢。
 * 改成 `CROSS JOIN` 钉住连接顺序（MATCH 驱动）后，罕见词 0.32 ms。
 *
 * 门槛取得很宽松（50 ms）—— 它拦的是**算法退化**（会差到秒级），不是慢机器。
 * 它不是性能目标，只是"别把查询计划改回去"的报警器。
 */
const rareQ = NEEDLE_TERM(0);
const rareP95 = report.latency['fts_needle:' + rareQ].p95;
check('稀有词检索成本与库内总量无关（< 50 ms，否则说明退化成全库扫描）',
  rareP95 < 50, 'P95 ' + rareP95 + ' ms @ ' + CHUNKS.toLocaleString('en-US') + ' chunk');

const commonP95 = Math.max(...QUERIES.filter((x) => x.kind === 'long').map(
  (x) => report.latency['fts_long:' + x.q].p95));
check('常见词（数千命中）检索 P95 < 1500 ms（退化成全库扫描时会是几十秒）',
  commonP95 < 1500, 'P95 ' + commonP95 + ' ms');

if (!NO_EMBED) {
  const n = 0;
  const qv = TOPIC_BASE[TOPICS + n];
  const r = searchVector({ tenantId: TENANT, kbIds: [KB], queryVec: qv, limit: 10 });
  const top = r.items[0];
  const needleRow = db.get('SELECT id FROM chunks WHERE body LIKE ? LIMIT 1', ['%' + NEEDLE_TERM(n) + '%']);
  check('稀有词的专属向量方向必须命中它自己（向量）',
    !!top && !!needleRow && Number(top.chunkId) === Number(needleRow.id),
    'top cosine ' + (top ? Number(top.score).toFixed(4) : '—'));

  const h = await knowledge.search({ tenantId: TENANT, query: NEEDLE_TERM(0), limit: 10, kbIds: [KB] });
  check('服务层混合检索必须返回带引用链的结果',
    h.results.length > 0 && !!h.results[0].citation.label,
    'RRF=' + (h.results[0] ? h.results[0].score.toFixed(4) : '—')
    + '｜引用 ' + (h.results[0] ? h.results[0].citation.label : '—'));
}

// 越权抽检：另一个租户查不到任何东西（规模大了更容易漏过滤条件）
const otherFts = searchFts({ tenantId: 'org_other', kbIds: [KB], query: '数据', limit: 10 });
check('大规模下跨租户 FTS 仍然 0 命中', otherFts.items.length === 0, '命中 ' + otherFts.items.length);
if (!NO_EMBED) {
  const otherVec = searchVector({ tenantId: 'org_other', kbIds: [KB], queryVec: TOPIC_BASE[1], limit: 10 });
  check('大规模下跨租户向量仍然 0 命中', otherVec.items.length === 0, '命中 ' + otherVec.items.length);
}

/* ── ⑤ 向量预过滤对照（B2）：延迟 × 召回损失 ───────────────────── */

/**
 * 体检报告 B2 的处置是"先预过滤（FTS 缩候选）再算余弦"，并且**要求能证伪**。
 * 这一段就是那个证伪器：同一批查询跑两次（`prefilter:false` 全量精确 vs `true` 预过滤），
 * 同时量**延迟**与**召回**——因为只报"快了 N 倍"而不报"丢了什么"，等于做了一半。
 *
 * 召回口径说明（重要，别误读）：
 *   这里量的是**服务层最终 top-K 的重合度**，不是向量路径自己的重合度。
 *   原因：向量列表的**排名**会变（在候选子集里，同一条 chunk 的 rank 会前进），
 *   经 RRF 融合后最终排序可能变化 —— 那才是用户真正看到的东西。
 *   `lost` = 基线里有、预过滤里没有的条数，这是召回损失的直接读数。
 */
if (!NO_EMBED) {
  console.log('');
  console.log('⑤ 向量预过滤（B2）对照：prefilter=false（全量精确）vs true（先缩候选再算余弦）');

  const PF_REPEATS = Math.max(3, Math.min(8, Math.ceil(REPEATS / 5)));
  const pfRows = [];

  const runOne = async (q, prefilter) => {
    const samples = [];
    let r0 = null;
    for (let i = 0; i < PF_REPEATS; i++) {
      const t0 = performance.now();
      const r = await knowledge.search({ tenantId: TENANT, query: q, limit: LIMIT, kbIds: [KB], prefilter });
      samples.push(performance.now() - t0);
      if (!r0) r0 = r;
    }
    return { p: percentiles(samples), r: r0 };
  };

  for (const { q, kind } of QUERIES) {
    const base = await runOne(q, false);
    const pre = await runOne(q, true);

    const setBase = new Set(base.r.results.map((x) => Number(x.chunkId)));
    const setPre = new Set(pre.r.results.map((x) => Number(x.chunkId)));
    const inter = [...setPre].filter((x) => setBase.has(x)).length;
    const lost = setBase.size - inter;
    const gained = setPre.size - inter;

    const row = {
      q, kind,
      scannedBase: base.r.retrieval.scannedVectors,
      scannedPre: pre.r.retrieval.scannedVectors,
      applied: pre.r.retrieval.prefilter.applied,
      reason: pre.r.retrieval.prefilter.reason,
      candidates: pre.r.retrieval.prefilter.candidates,
      p95Base: base.p.p95, p95Pre: pre.p.p95,
      kept: inter, lost, gained, baseSize: setBase.size,
    };
    pfRows.push(row);
    report.latency['prefilter_' + kind + ':' + q] = row;

    console.log('  ' + String(q).padEnd(16) + String(kind).padEnd(7)
      + '扫描 ' + (row.scannedBase + '→' + row.scannedPre).padStart(15)
      + '  重合 ' + (inter + '/' + setBase.size).padStart(6)
      + '  丢 ' + String(lost).padStart(2) + '  得 ' + String(gained).padStart(2)
      + '  P95 ' + (base.p.p95.toFixed(0) + '→' + pre.p.p95.toFixed(0) + ' ms').padStart(16)
      + '  ' + (row.applied ? '生效' : '退化(' + row.reason + ')'));
  }

  const applied = pfRows.filter((r) => r.applied);
  const totalLost = pfRows.reduce((s, r) => s + r.lost, 0);
  const totalKept = pfRows.reduce((s, r) => s + r.kept, 0);
  const totalBase = pfRows.reduce((s, r) => s + r.baseSize, 0);
  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

  console.log('  ——');
  console.log('  生效 ' + applied.length + '/' + pfRows.length + ' 个查询；'
    + '候选量级 ' + (applied[0] ? applied[0].candidates : 0) + ' 条；'
    + '召回保留 ' + totalKept + '/' + totalBase + '（丢 ' + totalLost + ' 条）');
  if (applied.length) {
    // 这一行才是文档要引用的数字：**只在生效的查询上**取平均 P95，
    // 把"退化"的那些混进来会低估收益（它们两种模式下都一样慢，白白摊薄）。
    const mBase = mean(applied.map((r) => r.p95Base));
    const mPre = mean(applied.map((r) => r.p95Pre));
    console.log('  生效查询的平均 P95：' + mBase.toFixed(0) + ' → ' + mPre.toFixed(0) + ' ms'
      + '（快 ' + (mBase > 0 ? (mBase / (mPre || 1)).toFixed(2) : '—') + ' 倍）');
  }

  check('预过滤至少对一个查询生效（全是"退化"说明它根本没被触发，等于白做）',
    applied.length > 0, applied.length + '/' + pfRows.length + ' 生效');

  const shrinkOk = applied.every((r) => r.scannedPre < r.scannedBase);
  check('生效时扫描量必须小于全量（否则它只是个装饰）',
    applied.length === 0 || shrinkOk,
    applied.length ? '例：' + applied[0].scannedBase + '→' + applied[0].scannedPre + ' 条' : '无生效样本');

  // 安全阀：字面 0 命中的查询**必须**退化为全量扫描，且向量路径不能被饿死。
  // 这条断言守的是整套预过滤里最容易静默失效的地方 —— 纯语义查询。
  const noHitQ = '量子纠缠退相干补丁';
  const noHitFts = searchFts({ tenantId: TENANT, kbIds: [KB], query: noHitQ, limit: 5 });
  const noHit = await knowledge.search({ tenantId: TENANT, query: noHitQ, limit: LIMIT, kbIds: [KB], prefilter: true });
  check('字面 0 命中的查询必须退化为全量扫描，且向量路径不得被饿死',
    noHitFts.items.length === 0
    && noHit.retrieval.prefilter.applied === false
    && noHit.retrieval.prefilter.reason === 'too_few_candidates'
    && noHit.retrieval.scannedVectors > 0,
    'FTS 命中 ' + noHitFts.items.length + '｜reason=' + noHit.retrieval.prefilter.reason
    + '｜仍扫描 ' + noHit.retrieval.scannedVectors + ' 条｜返回 ' + noHit.results.length + ' 条');

  report.prefilter = {
    repeats: PF_REPEATS,
    appliedCount: applied.length,
    totalKept, totalBase, totalLost,
    meanP95Base: applied.length ? Math.round(mean(applied.map((r) => r.p95Base))) : null,
    meanP95Pre: applied.length ? Math.round(mean(applied.map((r) => r.p95Pre))) : null,
    rows: pfRows,
  };
}

/* ── 汇总 ──────────────────────────────────────────────────────── */

await knowledge.close();
try { db.closeDb(); } catch { /* ignore */ }
if (stubServer) await new Promise((r) => stubServer.close(r));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('');
console.log('='.repeat(72));
const f = (p) => p.p50.toFixed(2) + ' / ' + p.p95.toFixed(2);
console.log('汇总（P50 / P95，单位 ms，样本量见 JSON）');
console.log('  文本检索（全部查询）      ' + f(report.latency.fts_all));
for (const [mode, arr] of ftsByMode) {
  console.log('    档位 ' + mode.padEnd(12) + '         ' + f(percentiles(arr)));
}
if (report.latency.vector_all) console.log('  向量暴力扫描（' + vecCount + ' 条）    ' + f(report.latency.vector_all));
if (report.latency.hybrid_all) console.log('  服务层混合检索（含 stub 往返）  ' + f(report.latency.hybrid_all));
console.log('');
console.log('口径说明：合成语料 + 合成向量。它回答的是"这个规模下这一层要花多少时间"，');
console.log('          不是"接上你的真实模型有多快"。真实模型延迟取决于服务商，不取决于本脚本。');

if (AS_JSON) console.log('JSON ' + JSON.stringify(report));

console.log('');
console.log('基准检查 ' + recallFails + ' 项不达标');
console.log('DONE fails=' + recallFails);
process.exitCode = recallFails ? 1 : 0;
