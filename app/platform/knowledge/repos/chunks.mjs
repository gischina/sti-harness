/**
 * 分块与向量仓储。
 *
 * 关键点：
 *  · `chunks.id` 是 INTEGER PRIMARY KEY（rowid 别名）——FTS5 触发器靠 rowid 关联，
 *    所以插入后必须拿到 `lastInsertRowid` 才能写对应的向量行。
 *  · **批量插入走单事务**：SQLite 是单写者，逐条 run() 会为每个分块各提交一次，
 *    导入一个几千块的大文档会慢一个数量级（且中途失败会留下半个文档）。
 *  · 向量的 `vec` 列存 Float32Array 的原始字节；读回用
 *    `new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)` ——
 *    不能 `Array.from(buf)`，那样会得到一堆 0–255 的字节，而不是浮点数。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { run, all, get, tx } from '../../../data/db.mjs';

/** Float32Array → BLOB（零拷贝视图） */
export function vecToBlob(vec) {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

/** BLOB → Float32Array（零拷贝视图；调用方不得复用原 buffer） */
export function blobToVec(buf) {
  if (!buf) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/**
 * 批量写入分块（含可选向量）。
 * @param {{docId:string, kbId:string, chunks:Array, vectors?:Float32Array[]|null, dim?:number}} input
 * @returns {{inserted:number, vectors:number}}
 */
export function insertChunks({ docId, kbId, chunks, vectors = null, dim = 0 }) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (!list.length) return { inserted: 0, vectors: 0 };

  return tx(() => {
    let inserted = 0;
    let vecCount = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const r = run(
        `INSERT INTO chunks (doc_id, kb_id, ord, body, bigrams, meta_json, token_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          docId, kbId, Number(c.ord != null ? c.ord : i),
          String(c.body == null ? '' : c.body),
          String(c.bigrams == null ? '' : c.bigrams),
          JSON.stringify(c.meta || {}),
          Number(c.tokenCount) || 0,
        ]
      );
      inserted++;
      const chunkId = Number(r.lastInsertRowid);
      const v = vectors && vectors[i];
      if (v && v.length) {
        run('INSERT INTO chunk_vectors (chunk_id, dim, vec) VALUES (?, ?, ?)',
          [chunkId, Number(dim) || v.length, vecToBlob(v)]);
        vecCount++;
      }
    }
    return { inserted, vectors: vecCount };
  });
}

/**
 * 删除某文档的全部分块与向量（**不带事务**）。FTS 由 chunks 上的触发器同步清理。
 *
 * ⚠️ 为什么要拆成两个函数：`deleteChunksForDoc` 经常在更外层的 `tx()` 里被调用
 * （例如「删知识库」要在一个事务里删掉库+文档+分块）。而 db.mjs 明确**不支持嵌套事务**
 * （SQLite 的 BEGIN 不可重入），嵌套会抛
 * `cannot start a transaction within a transaction`。
 * 所以：外层已经有事务时用 `deleteChunksForDoc`，独立调用时用 `deleteChunksByDoc`。
 */
export function deleteChunksForDoc(docId) {
  const ids = all('SELECT id FROM chunks WHERE doc_id = ?', [docId]).map((r) => Number(r.id));
  for (const cid of ids) run('DELETE FROM chunk_vectors WHERE chunk_id = ?', [cid]);
  const r = run('DELETE FROM chunks WHERE doc_id = ?', [docId]);
  return Number(r && r.changes ? r.changes : 0);
}

export function deleteChunksByDoc(docId) {
  return tx(() => deleteChunksForDoc(docId));
}

/** 列表（用于分块预览）。带出文档标题，便于前端直接展示引用链 */
export function listChunksByDoc(docId, { limit = 100, offset = 0 } = {}) {
  return all(
    `SELECT c.id, c.doc_id, c.ord, c.body, c.meta_json, c.token_count,
            (SELECT COUNT(*) FROM chunk_vectors v WHERE v.chunk_id = c.id) AS has_vector
       FROM chunks c
      WHERE c.doc_id = ?
      ORDER BY c.ord
      LIMIT ? OFFSET ?`,
    [docId, Number(limit) || 100, Number(offset) || 0]
  );
}

export function countChunksByDoc(docId) {
  const r = get('SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?', [docId]);
  return r ? Number(r.n) : 0;
}

export function countChunks() {
  const r = get('SELECT COUNT(*) AS n FROM chunks');
  return r ? Number(r.n) : 0;
}

export function countVectors() {
  const r = get('SELECT COUNT(*) AS n FROM chunk_vectors');
  return r ? Number(r.n) : 0;
}
