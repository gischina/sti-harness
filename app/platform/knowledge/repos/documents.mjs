/**
 * 文档仓储。
 *
 * 状态机：`pending → parsing → ready | failed`
 *   · 只有 `ready` 的文档才会进入检索集（服务层的检索 SQL 强制 `d.status='ready'`）；
 *   · `failed` 保留**原始错误文本**（含外部命令的 stderr 摘要），
 *     不是一句「解析失败」—— 因为要让人知道是「缺 pdftotext」还是「文件损坏」。
 *
 * 所有查询 `JOIN knowledge_bases` 过滤租户（见 bases.mjs 顶部说明）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { run, all, get } from '../../../data/db.mjs';
import { newId, nowIso } from '../../../util/ids.mjs';

export function createDocument({
  kbId, title = '', mime = '', size = 0, sha256 = '', storagePath = '',
  sourceType = '', sourceRef = '', status = 'pending',
}) {
  const id = newId('doc');
  const at = nowIso();
  run(
    `INSERT INTO documents
       (id, kb_id, title, mime, size, sha256, storage_path, status, error, chunk_count,
        created_at, parsed_at, source_type, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, NULL, ?, ?)`,
    [id, kbId, title, mime, Number(size) || 0, sha256, storagePath, status, at, sourceType, sourceRef]
  );
  return getDocument(null, id);
}

/** 按 id 取（tenantId 为 null 时表示"已知调用方已校验过租户"的内部路径，谨慎使用） */
export function getDocument(tenantId, id) {
  if (tenantId) {
    return get(
      `SELECT d.* FROM documents d
         JOIN knowledge_bases kb ON kb.id = d.kb_id
        WHERE kb.tenant_id = ? AND d.id = ?`,
      [tenantId, id]
    );
  }
  return get('SELECT * FROM documents WHERE id = ?', [id]);
}

export function listDocuments(kbId, { limit = 100, offset = 0, status = null } = {}) {
  if (status) {
    return all('SELECT * FROM documents WHERE kb_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [kbId, status, Number(limit) || 100, Number(offset) || 0]);
  }
  return all('SELECT * FROM documents WHERE kb_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [kbId, Number(limit) || 100, Number(offset) || 0]);
}

export function countDocuments(kbId, status = null) {
  const r = status
    ? get('SELECT COUNT(*) AS n FROM documents WHERE kb_id = ? AND status = ?', [kbId, status])
    : get('SELECT COUNT(*) AS n FROM documents WHERE kb_id = ?', [kbId]);
  return r ? Number(r.n) : 0;
}

/** 重复检测：同一知识库里 sha256 相同的文档（导入前提示，而不是默默存两份） */
export function findBySha(kbId, sha256) {
  return get('SELECT * FROM documents WHERE kb_id = ? AND sha256 = ? AND status = ?', [kbId, sha256, 'ready']);
}

export function setDocumentStatus(id, status, { error = null, parsedAt = null } = {}) {
  run('UPDATE documents SET status = ?, error = ?, parsed_at = COALESCE(?, parsed_at) WHERE id = ?',
    [status, error, parsedAt, id]);
  return getDocument(null, id);
}

/**
 * 回填存储路径。
 * 为什么单独一个方法：路径里含文档 id，而 id 只有**插入之后**才存在
 * （早先在 createDocument 的参数里直接用 doc.id 触发过 TDZ 报错）。
 */
export function setStoragePath(id, storagePath) {
  run('UPDATE documents SET storage_path = ? WHERE id = ?', [String(storagePath || ''), id]);
  return getDocument(null, id);
}

/** 一次更新状态 + 分块数（导入成功的收尾） */
export function finishDocument(id, { chunkCount, parsedAt = nowIso() }) {
  run('UPDATE documents SET status = ?, error = NULL, chunk_count = ?, parsed_at = ? WHERE id = ?',
    ['ready', Number(chunkCount) || 0, parsedAt, id]);
  return getDocument(null, id);
}

/**
 * 记录本文档的向量来源（0010）。
 *
 * 为什么值得单独一格：不记它，"同一知识库里两种模型嵌入的向量混着比"这件事
 * 就完全不可见 —— 检索只是"结果变差"，没有任何报错，也没人会往那个方向想。
 * 记下来之后，页面能明确说出"这份文档是 A 模型嵌的，当前默认是 B"。
 */
export function setDocumentEmbedding(id, { provider = '', model = '', dim = 0 } = {}) {
  run('UPDATE documents SET embedding_provider = ?, embedding_model = ?, embedding_dim = ? WHERE id = ?',
    [String(provider || ''), String(model || ''), Number(dim) || 0, id]);
  return getDocument(null, id);
}

/** 改标题：只动显示字段，sha256 / 分块 / 向量一律不碰（改名不该触发重新解析） */
export function renameDocument(id, title) {
  run('UPDATE documents SET title = ? WHERE id = ?', [String(title || ''), id]);
  return getDocument(null, id);
}

export function deleteDocument(id) {
  const row = getDocument(null, id);
  if (!row) return { deleted: false };
  run('DELETE FROM documents WHERE id = ?', [id]);
  return { deleted: true, document: row };
}

/** 知识库维度的状态统计（状态页用，全部实测） */
export function statusCounts(kbId) {
  const rows = all('SELECT status, COUNT(*) AS n FROM documents WHERE kb_id = ? GROUP BY status', [kbId]);
  const out = { pending: 0, parsing: 0, ready: 0, failed: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}
