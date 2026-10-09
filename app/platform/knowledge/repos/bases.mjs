/**
 * 知识库仓储。
 *
 * 纪律与 M0 的会话仓储一致：**所有查询强制带 tenant_id 过滤**。
 * 注意 `documents` / `chunks` 表本身没有 `tenant_id` 列（它们只挂在 kb 下），
 * 所以它们的仓库一律 `JOIN knowledge_bases` 来过滤租户 —— 这是故意的：
 * 让「忘记加租户条件」在 SQL 层面就写不出来，而不是靠人记得。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { run, all, get, tx } from '../../../data/db.mjs';
import { newId, nowIso } from '../../../util/ids.mjs';
import { deleteChunksForDoc } from './chunks.mjs';

export function createBase({ tenantId, name, embeddingProvider = '', embeddingModel = '', dim = 0, visibility = 'tenant' }) {
  const id = newId('kb');
  const at = nowIso();
  run(
    `INSERT INTO knowledge_bases (id, tenant_id, name, embedding_provider, embedding_model, dim, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, tenantId, name, embeddingProvider, embeddingModel, Number(dim) || 0, String(visibility || 'tenant'), at]
  );
  return getBase(tenantId, id);
}

export function getBase(tenantId, id) {
  return get('SELECT * FROM knowledge_bases WHERE tenant_id = ? AND id = ?', [tenantId, id]);
}

/** 按名字取（用于「同名就复用」这类幂等操作） */
export function getBaseByName(tenantId, name) {
  return get('SELECT * FROM knowledge_bases WHERE tenant_id = ? AND name = ?', [tenantId, name]);
}

export function listBases(tenantId) {
  return all(
    `SELECT kb.*,
            (SELECT COUNT(*) FROM documents d WHERE d.kb_id = kb.id) AS document_count,
            (SELECT COALESCE(SUM(d.chunk_count), 0) FROM documents d WHERE d.kb_id = kb.id) AS chunk_count
       FROM knowledge_bases kb
      WHERE kb.tenant_id = ?
      ORDER BY kb.created_at DESC`,
    [tenantId]
  );
}

export function updateBaseEmbedding(tenantId, id, { embeddingProvider, embeddingModel, dim }) {
  const fields = [];
  const params = [];
  if (embeddingProvider !== undefined) { fields.push('embedding_provider = ?'); params.push(embeddingProvider); }
  if (embeddingModel !== undefined) { fields.push('embedding_model = ?'); params.push(embeddingModel); }
  if (dim !== undefined) { fields.push('dim = ?'); params.push(Number(dim) || 0); }
  if (!fields.length) return getBase(tenantId, id);
  params.push(tenantId, id);
  run('UPDATE knowledge_bases SET ' + fields.join(', ') + ' WHERE tenant_id = ? AND id = ?', params);
  return getBase(tenantId, id);
}

export function renameBase(tenantId, id, name) {
  run('UPDATE knowledge_bases SET name = ? WHERE tenant_id = ? AND id = ?', [name, tenantId, id]);
  return getBase(tenantId, id);
}

/**
 * 改可见性（`tenant` ↔ `restricted`，见 `knowledge/visibility.mjs`）。
 * 值域校验在服务层（`normalizeVisibility`）—— 仓储层只负责写，
 * 这样"坏值被拒"的规则只有一处定义，不会两条路径给出不同结果。
 */
export function updateBaseVisibility(tenantId, id, visibility) {
  run('UPDATE knowledge_bases SET visibility = ? WHERE tenant_id = ? AND id = ?', [String(visibility), tenantId, id]);
  return getBase(tenantId, id);
}

/**
 * 删除知识库及其全部文档、分块、向量。
 * **单事务**完成：不留下「库没了但分块还在」的孤儿数据
 * （孤儿分块会被 FTS 检索到 → 已删内容还能被召回，等于删不掉）。
 */
export function deleteBase(tenantId, id) {
  const row = getBase(tenantId, id);
  if (!row) return { deleted: false, documents: 0, chunks: 0 };
  return tx(() => {
    const docIds = all('SELECT id FROM documents WHERE kb_id = ?', [id]).map((r) => r.id);
    let removedChunks = 0;
    for (const docId of docIds) {
      // 用**不带事务**的版本：这里已经在外层 tx() 里了，嵌套事务会直接抛错
      removedChunks += deleteChunksForDoc(docId);
      run('DELETE FROM documents WHERE id = ?', [docId]);
    }
    run('DELETE FROM knowledge_bases WHERE tenant_id = ? AND id = ?', [tenantId, id]);
    return { deleted: true, documents: docIds.length, chunks: removedChunks };
  });
}
