/**
 * FTS5 文本检索（中文经 bigram）。
 *
 * 四级查询阶梯（**这是中文检索能用的关键**）：
 *   1. `phrase` —— CJK 部分作**保序短语**匹配（精确，「权限管理」只命中连续出现）
 *   2. `or`     —— CJK 部分**段内**作 OR 组合（容忍换序，「管理权限」也能命中「权限管理」）
 *   3. `any`    —— **全局 OR**，放开段间 AND（容忍"整句提问里夹着文档没提的从句"，
 *                  例：「根据知识库：备份怎么做？只回答一句话」）
 *   4. `like`   —— 单字兜底（用户只输一个「权」时，bigram 切不出双字词，
 *                  只能退回 `LIKE` 扫描。**明确标注用了兜底**，因为它会慢且不精确）
 *
 * 每一级只有在前一级 0 命中时才启用，最终结果里带 `matchMode` ——
 * 使用者能知道「这次是靠精确匹配还是靠兜底扫出来的」。
 *
 * 排序用 FTS5 的 `bm25()`：**值越小越相关**，因此 `ORDER BY score ASC`。
 *
 * 隔离：SQL 里同时约束 `kb.tenant_id`（租户）与 `c.kb_id IN (...)`（库范围），
 * 并且只检索 `d.status='ready'` 的文档（解析失败的内容不得进入结果集）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { all } from '../../../data/db.mjs';
import { buildQueryLadder, tokenize } from '../../../util/bigram.mjs';
import { parseJsonSafe } from '../../../util/json.mjs';

function kbClause(kbIds) {
  const ids = (kbIds || []).filter(Boolean);
  if (!ids.length) return null;
  return { sql: ' AND c.kb_id IN (' + ids.map(() => '?').join(',') + ')', params: ids };
}

/**
 * ⚠️ 这里的 `CROSS JOIN` 不是为了省字，而是**为了钉住查询计划**。
 *
 * 实测（tools/bench-search.mjs，5 万 chunk）：写成普通 JOIN 时，SQLite 会自作聪明地
 * 先按 `kb_id` 走 idx_chunks_kb 扫出**库内全部 chunk**，再逐条回查 FTS 虚拟表：
 *   SEARCH c USING INDEX idx_chunks_kb (kb_id=?) → SCAN chunk_fts VIRTUAL TABLE
 * 于是一次检索的代价变成 O(库内分块总数)，而不是 O(命中数)：
 *   常见词（4994 命中）1150 ms、罕见词（1 命中）299 ms —— 罕见词反而更慢，说明根本没走索引。
 *
 * 改成 CROSS JOIN 后计划变为 MATCH 驱动：
 *   SCAN chunk_fts VIRTUAL TABLE INDEX 0:M2 → SEARCH c USING INTEGER PRIMARY KEY (rowid=?)
 *   → 常见词 17 ms（快 68 倍）、罕见词 0.32 ms（快 900 倍）。
 *
 * SQLite 文档明确 CROSS JOIN **禁止重排该连接对**，这正是我们要的语义。
 * 谁要是把它"整理"回普通 JOIN，bench-search 里的查询计划断言会立刻红。
 */

/** 全列：给检索结果用（要 body / meta / 文档标题才能组装引用链） */
const COLS_FULL = `c.id AS chunk_id, c.doc_id, c.kb_id, c.ord, c.body, c.meta_json, c.token_count,
         d.title AS doc_title, d.mime AS doc_mime, d.source_type, d.source_ref,
         bm25(chunk_fts) AS score`;

/**
 * 只取 id：给**向量预过滤**用（B2）。
 * 候选常有几百条，读它们的正文纯属浪费 —— 真正需要正文的是最终进入结果的那几十条
 * （由 vector.mjs 的第二趟按 id 回填）。`score` 仍要选：候选按 bm25 取前 N 条才有意义。
 */
const COLS_IDS = `c.id AS chunk_id, bm25(chunk_fts) AS score`;

function selectSql(cols, kbSql) {
  return `
  SELECT ${cols}
    FROM chunk_fts
    CROSS JOIN chunks c ON c.id = chunk_fts.rowid
    JOIN documents d ON d.id = c.doc_id
    JOIN knowledge_bases kb ON kb.id = c.kb_id
   WHERE chunk_fts MATCH ?
     AND kb.tenant_id = ?
     AND d.status = 'ready'${kbSql}`;
}

/**
 * 跑一次查询阶梯（phrase → and），返回**原始行**。
 * 抽出来是为了让「取正文的结果查询」与「只取 id 的候选查询」**永远共用同一套匹配语义** ——
 * 否则两份 SQL 会各自漂移，出现"候选来自 A 规则、结果来自 B 规则"这种查不出来的口径分裂。
 *
 * @returns {{rows:Array, matchMode:string, attempted:string[], notes:string[]}}
 */
function runLadder({ tenantId, kb, query, limit, cols }) {
  const notes = [];
  const attempted = [];
  const ladder = buildQueryLadder(query);
  if (!ladder.length) return { rows: [], matchMode: 'none', attempted, notes: ['查询为空'] };

  const sql = selectSql(cols, kb.sql) + ' ORDER BY score ASC LIMIT ?';
  for (const step of ladder) {
    attempted.push(step.mode);
    let rows = [];
    try {
      rows = all(sql, [step.match, tenantId, ...kb.params, Number(limit) || 20]);
    } catch (e) {
      notes.push('FTS 查询失败（' + step.mode + '）：' + e.message);
      continue;
    }
    if (rows.length) return { rows, matchMode: 'fts:' + step.mode, attempted, notes };
  }
  return { rows: [], matchMode: 'fts:none', attempted, notes };
}

/**
 * @param {{tenantId:string, kbIds:string[], query:string, limit?:number}} args
 * @returns {{items:Array, matchMode:string, attempted:string[], notes:string[]}}
 */
export function searchFts({ tenantId, kbIds, query, limit = 20 }) {
  const kb = kbClause(kbIds);
  if (!kb) return { items: [], matchMode: 'none', attempted: [], notes: ['未指定知识库范围，检索不执行'] };

  const r = runLadder({ tenantId, kb, query, limit, cols: COLS_FULL });
  if (r.rows.length) {
    return {
      items: r.rows.map((row, i) => ({
        chunkId: Number(row.chunk_id),
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
        score: Number(row.score),
        rank: i + 1,
        via: r.matchMode,              // 与 matchMode 同串（'fts:phrase' 等），不另拼一份
      })),
      matchMode: r.matchMode,
      attempted: r.attempted,
      notes: r.notes,
    };
  }
  // 阶梯一次都没跑（查询为空）→ 连兜底都不必试
  if (!r.attempted.length) return { items: [], matchMode: 'none', attempted: [], notes: r.notes };

  const notes = [...r.notes];
  const attempted = [...r.attempted];

  // 兜底：单字 / 极短查询 —— bigram 切不出词，只能 LIKE
  const single = singleCharQuery(query);
  if (single) {
    attempted.push('like');
    const likeSql = `
      SELECT c.id AS chunk_id, c.doc_id, c.kb_id, c.ord, c.body, c.meta_json, c.token_count,
             d.title AS doc_title, d.mime AS doc_mime, d.source_type, d.source_ref
        FROM chunks c
        JOIN documents d ON d.id = c.doc_id
        JOIN knowledge_bases kb ON kb.id = c.kb_id
       WHERE kb.tenant_id = ?
         AND d.status = 'ready'
         AND c.body LIKE ? ESCAPE '\\'
         ${kb.sql}
       ORDER BY c.id
       LIMIT ?`;
    const pattern = '%' + single.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    let rows = [];
    try {
      rows = all(likeSql, [tenantId, pattern, ...kb.params, Number(limit) || 20]);
    } catch (e) {
      notes.push('LIKE 兜底失败：' + e.message);
    }
    if (rows.length) {
      notes.push('精确、段内 OR、全局 OR 三档都没有命中，本条结果来自单字 LIKE 兜底（不精确，可能包含无关内容）');
      return {
        items: rows.map((row, i) => ({
          chunkId: Number(row.chunk_id), docId: row.doc_id, kbId: row.kb_id, ord: Number(row.ord),
          body: row.body, meta: parseJsonSafe(row.meta_json), tokenCount: Number(row.token_count) || 0,
          docTitle: row.doc_title, docMime: row.doc_mime, sourceType: row.source_type, sourceRef: row.source_ref,
          score: 0, rank: i + 1, via: 'fts:like',
        })),
        matchMode: 'fts:like',
        attempted,
        notes,
      };
    }
  }

  return { items: [], matchMode: 'fts:none', attempted, notes };
}

/**
 * 只为**向量预过滤**取候选 chunk id（B2）。
 *
 * 与 `searchFts` 共用同一套 kbClause / SQL / 查询阶梯，因此"候选来自哪些匹配规则"
 * 与"文本结果来自哪些匹配规则"不可能出现两套口径。
 *
 * ⚠️ **刻意不走 LIKE 兜底**。对比 searchFts 的差异只有这一处，理由：
 *   兜底针对的是单字/极短查询，它返回的是"字面偶然包含这个字"的内容（自身都不精确）。
 *   拿它当余弦的候选集，等于把算力花在无关内容上，还会让"语义相关但不含该字"的内容出局。
 *   阶梯 0 命中时这里返回空 ids —— 由调用方（service）判定"候选不足 → 退化为全量扫描"，
 *   于是极短/纯语义查询自动回到**召回无损**的精确全扫描，只是慢。
 *
 * @param {{tenantId:string, kbIds:string[], query:string, limit?:number}} args
 * @returns {{ids:number[], matchMode:string, attempted:string[], notes:string[]}}
 */
export function searchFtsIds({ tenantId, kbIds, query, limit = 512 }) {
  const kb = kbClause(kbIds);
  if (!kb) return { ids: [], matchMode: 'none', attempted: [], notes: ['未指定知识库范围，检索不执行'] };
  const r = runLadder({ tenantId, kb, query, limit, cols: COLS_IDS });
  const ids = [];
  for (const row of r.rows) {
    const n = Number(row.chunk_id);
    if (Number.isFinite(n)) ids.push(n);
  }
  return { ids, matchMode: r.matchMode, attempted: r.attempted, notes: r.notes };
}

/** 极短查询（1 个 CJK 字或 1–2 个字符）才走 LIKE 兜底 */
function singleCharQuery(q) {
  const s = String(q || '').trim();
  if (!s) return null;
  const tokens = tokenize(s);
  if (tokens.length === 0) return s.length <= 2 ? s : null;
  // 全部 token 都是单字/短词，且整体很短 → 兜底
  return s.length <= 2 ? s : null;
}
