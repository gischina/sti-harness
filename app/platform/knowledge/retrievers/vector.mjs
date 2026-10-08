/**
 * 向量检索（暴力余弦）。
 *
 * 为什么是暴力而不是 ANN 索引：
 *   引入 HNSW/IVF 的代价是一个新依赖、一份需要持久化与重建的索引、
 *   以及"召回不再精确"这个**不可测**的损失 —— 而暴力扫描的召回是完全可解释的。
 *   因此 M2 选择**精确但朴素**，并把实测 P95 写进 docs/benchmark.md，
 *   等数据量真的把它压垮了再换，换的时候有基准可以对照。
 *
 * ⚠️ 但"朴素"不等于"慢得理所当然"。实测（tools/bench-search.mjs）：
 *   一次查询要读遍范围内**每一行**向量的 BLOB，成本随分块数线性增长，
 *   10 万 × 256 维约几百毫秒 —— 这个数字是**实测**出来的，不是估的。
 *   所以这里做了两件事：(1) 扫描趟只取 `chunk_id + dim + vec`，正文按 id 回填；
 *   (2) 扫描量超过阈值就在结果里带上提示，让成本在使用侧可见。
 *   想把它降到毫秒级只有换 ANN，那是 M3 以后的事。
 *
 * 因为写入时已做 L2 归一化，这里余弦相似度 = 点积，省掉每次开方。
 *
 * 隔离：候选集的 SQL 同时约束 `kb.tenant_id` 与 `c.kb_id IN (...)`，
 * 与 FTS 路径**各写一遍各自的过滤条件**（两条路径都必须独立可信，不共用中间结果）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { all } from '../../../data/db.mjs';
import { blobToVec } from '../repos/chunks.mjs';
import { parseJsonSafe } from '../../../util/json.mjs';

/** 扫描量超过这个数就在结果里给出提示 —— 暴力扫描的成本必须让用户看得见 */
const BIG_SCAN = 50000;

/**
 * `IN (...)` 的变量数上限。SQLite 3.32+ 默认 32766，更老的版本只有 999。
 * 取 900 是**按老版本对齐**的保守值：预过滤候选本该是几百条量级
 * （配置项 `prefilterCandidates` 默认 512），真到了九百条以上，
 * 预过滤省下的成本已很有限 —— 此时如实降级为全扫描，比硬塞进 SQL 更对。
 */
const SAFE_IN_LIMIT = 900;
export { SAFE_IN_LIMIT };

/**
 * @param {{tenantId:string, kbIds:string[], queryVec:Float32Array, limit?:number,
 *          candidateIds?:number[]|null}} args
 *   `candidateIds`（B2 预过滤）：给了就**只在这些 chunk 上算余弦**。
 *   传 `null`/不传 = 全量精确扫描（既有行为，一字未改）。
 *   传空数组 = 候选集为空 → 如实返回空结果（**不**偷偷退回全扫）。
 *   为什么这个区分重要：调用方（service）判断"候选不足"时会显式传 `null` 去走全扫，
 *   所以"传了空数组"只可能是真的没有候选 —— 静默退回全扫会让"预过滤没生效"
 *   变成一个查不出来的事实。
 */
export function searchVector({ tenantId, kbIds, queryVec, limit = 20, candidateIds = null }) {
  const notes = [];
  const ids = (kbIds || []).filter(Boolean);
  if (!ids.length) return { items: [], scanned: 0, skipped: 0, prefilter: prefilterState(candidateIds, false), notes: ['未指定知识库范围，检索不执行'] };
  if (!queryVec || !queryVec.length) return { items: [], scanned: 0, skipped: 0, prefilter: prefilterState(candidateIds, false), notes: ['没有查询向量（未配置 embedding 时会走到这里，属预期）'] };

  const cand = Array.isArray(candidateIds)
    ? [...new Set(candidateIds.map(Number).filter((n) => Number.isFinite(n)))]
    : null;

  if (cand && !cand.length) {
    // 候选集为空 = 这次预过滤没有可算的东西。如实返回空，并说清不是"库里没内容"。
    return {
      items: [], scanned: 0, skipped: 0, prefilter: prefilterState(cand, true),
      notes: ['预过滤候选集为空，本次未执行任何余弦计算（文本侧结果不受影响）'],
    };
  }

  let applied = false;
  if (cand && cand.length <= SAFE_IN_LIMIT) applied = true;

  /**
   * 第一趟只取 `chunk_id + dim + vec`。**不要**在这一趟里把 body / meta / 文档标题也查出来：
   * 实测（5 千 chunk / 256 维）宽查询 53.8 ms，窄查询 21.5 ms —— 差的那 30 ms 全是
   * 白读了 (N - keep) 行正文，而它们根本进不了结果。正文只在第二趟按 id 回填 top-K。
   */
  let sql = `
    SELECT v.chunk_id, v.dim, v.vec
      FROM chunk_vectors v
      JOIN chunks c ON c.id = v.chunk_id
      JOIN knowledge_bases kb ON kb.id = c.kb_id
     WHERE kb.tenant_id = ?
       AND c.doc_id IN (SELECT id FROM documents WHERE status = 'ready')
       AND c.kb_id IN (${ids.map(() => '?').join(',')})`;
  const params = [tenantId, ...ids];

  if (applied) {
    // 预过滤：把候选内联进 SQL（同一趟完成"缩候选 + 取向量的 BLOB"），
    // 比"先查候选再逐条查向量"少一次往返，也避免把几百个 id 在 JS 里搬来搬去。
    sql += `\n       AND v.chunk_id IN (${cand.map(() => '?').join(',')})`;
    params.push(...cand);
  }

  const rows = all(sql, params);

  const want = Math.max(1, Number(limit) || 20);
  const keep = want * 3;                 // 先多留一些，融合时排序更稳
  let scanned = 0;
  let skipped = 0;
  const top = [];
  let minScore = -Infinity;

  for (const r of rows) {
    const vec = blobToVec(r.vec);
    if (!vec || vec.length !== queryVec.length) { skipped++; continue; }
    scanned++;
    let dot = 0;
    for (let i = 0; i < vec.length; i++) dot += vec[i] * queryVec[i];
    if (top.length >= keep && dot <= minScore) continue;
    top.push({ score: dot, chunkId: Number(r.chunk_id) });
    if (top.length > keep * 2) {
      top.sort((a, b) => b.score - a.score);
      top.length = keep;
      minScore = top[top.length - 1].score;
    }
  }

  top.sort((a, b) => b.score - a.score);
  top.length = Math.min(top.length, keep);

  if (skipped) {
    notes.push('有 ' + skipped + ' 条向量因维度与查询向量不一致被跳过（通常是换过 embedding 模型，需要重建索引）');
  }
  if (!rows.length) {
    notes.push(applied
      ? '预过滤候选里没有任何向量记录（候选来自文本命中，而这些分块未向量化或已被删除）'
      : '该范围内没有任何向量记录（知识库未启用向量，或文档尚未向量化）');
  }
  if (applied) {
    // 代价必须让使用者看见：这句话回答"我的纯语义召回去哪了"。
    notes.push('向量检索已预过滤：只在文本命中的 ' + cand.length + ' 条候选里算余弦（扫描 ' + scanned + ' 条）。'
      + '代价是纯语义召回 —— 字面不含查询词、但语义相关的内容不在候选内，因此不会被返回；'
      + '要关掉它请在配置里设 prefilterVector=false（对照实测见 docs/benchmark.md §10）。');
  }
  if (cand && !applied) {
    // 候选超上限：如实说，不静默退回全扫。
    notes.push('预过滤候选有 ' + cand.length + ' 条，超过安全上限 ' + SAFE_IN_LIMIT
      + '，本次退化为全量扫描（请把 prefilterCandidates 调小；候选这么多时预过滤已省不下什么）。');
  }
  if (scanned >= BIG_SCAN) {
    notes.push('向量检索是暴力扫描：本次扫描 ' + scanned + ' 条向量。'
      + '这是精确检索（召回无损）换来的线性成本，实测数字见 docs/benchmark.md；'
      + '数据量再大一个量级就需要 ANN 索引（M2 未做）。');
  }

  const hydrated = hydrate(top.map((t) => t.chunkId));
  const items = [];
  for (const t of top) {
    const row = hydrated.get(t.chunkId);
    if (!row) continue;                  // 回填时被删掉的行：跳过，不编造
    items.push({
      chunkId: t.chunkId,
      docId: row.doc_id,
      kbId: row.kb_id,
      ord: Number(row.ord),
      body: row.body,
      meta: parseJsonSafe(row.meta_json),
      tokenCount: Number(row.token_count) || 0,
      docTitle: row.doc_title,
      docMime: row.doc_mime,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      score: t.score,                    // 余弦相似度（-1..1，越大越相关）
      rank: items.length + 1,
      via: 'vector',
    });
  }

  return { items, scanned, skipped, prefilter: prefilterState(cand, applied), notes };
}

/**
 * 预过滤状态 —— 结构化地说明"这次到底预过滤了没有、为什么"。
 * 三态比一个布尔值有用：调用方与页面能区分「没请求」「请求了但退化」「真的生效了」。
 */
function prefilterState(cand, applied) {
  return {
    requested: Array.isArray(cand),
    applied: applied === true,
    candidates: Array.isArray(cand) ? cand.length : 0,
  };
}

/** 第二趟：只按 id 回填进入候选的那几十行（走主键，代价可忽略） */
function hydrate(chunkIds) {
  const uniq = [...new Set(chunkIds)].filter((x) => Number.isFinite(x));
  if (!uniq.length) return new Map();
  const sql = `
    SELECT c.id AS chunk_id, c.doc_id, c.kb_id, c.ord, c.body, c.meta_json, c.token_count,
           d.title AS doc_title, d.mime AS doc_mime, d.source_type, d.source_ref
      FROM chunks c
      JOIN documents d ON d.id = c.doc_id
     WHERE c.id IN (${uniq.map(() => '?').join(',')})`;
  const out = new Map();
  for (const r of all(sql, uniq)) out.set(Number(r.chunk_id), r);
  return out;
}
