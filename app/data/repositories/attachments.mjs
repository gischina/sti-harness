/**
 * 会话附件仓储。
 *
 * 纪律（与 sessions.mjs 同款，且更严）：**每一条语句都带 tenant_id**。
 * 附件是按 id 直接寻址的资源（`GET …/attachments/:attId`），
 * 不能依赖"先查会话再判断归属"这种间接推理 —— 一旦有人写快了漏掉那一步，
 * 就变成"知道 id 就能下载别家文件"。所以过滤条件写在**每一句 SQL 里**。
 *
 * 这一层只管元数据；字节落盘/读取在路由层做（见 app/http/routes/kernel.mjs），
 * 因为"存到哪、叫什么名"属于运行时信息（paths.mjs），不属于数据层。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { run, all, get } from '../db.mjs';
import { newId, nowIso } from '../../util/ids.mjs';

/**
 * 登记一个附件（字节已由调用方落盘）。
 * @param {{tenantId:string, sessionId:string, userId?:string|null,
 *          name:string, mime?:string, bytes:number, kind:string,
 *          storedPath:string, sha256?:string}} input
 */
export function createAttachment(input) {
  const id = newId('att');
  const at = nowIso();
  run(
    `INSERT INTO session_attachments
       (id, tenant_id, session_id, user_id, name, mime, bytes, kind, stored_path, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, input.tenantId, input.sessionId, input.userId || null,
      String(input.name), String(input.mime || ''), Number(input.bytes) || 0,
      String(input.kind), String(input.storedPath), String(input.sha256 || ''), at,
    ]
  );
  return getAttachment(input.tenantId, input.sessionId, id);
}

export function getAttachment(tenantId, sessionId, id) {
  return get(
    'SELECT * FROM session_attachments WHERE tenant_id = ? AND session_id = ? AND id = ?',
    [tenantId, sessionId, id]
  );
}

export function listAttachments(tenantId, sessionId, { limit = 200 } = {}) {
  return all(
    'SELECT * FROM session_attachments WHERE tenant_id = ? AND session_id = ? ORDER BY created_at ASC LIMIT ?',
    [tenantId, sessionId, Math.max(1, Number(limit) || 200)]
  );
}

/** 按 id 批量取（注入轮次上下文时用；顺序按入参，取不到的忽略） */
export function getAttachmentsByIds(tenantId, sessionId, ids) {
  const out = [];
  for (const id of (Array.isArray(ids) ? ids : [])) {
    const row = getAttachment(tenantId, sessionId, String(id));
    if (row) out.push(row);
  }
  return out;
}

export function deleteAttachment(tenantId, sessionId, id) {
  run(
    'DELETE FROM session_attachments WHERE tenant_id = ? AND session_id = ? AND id = ?',
    [tenantId, sessionId, id]
  );
  return { id };
}

export function countAttachments(tenantId, sessionId) {
  const r = get(
    'SELECT COUNT(*) AS n FROM session_attachments WHERE tenant_id = ? AND session_id = ?',
    [tenantId, sessionId]
  );
  return r ? Number(r.n) : 0;
}

/**
 * 删除某会话的全部附件元数据（0.16.0 会话删除的级联面）。
 *
 * 返回**删除前**读出的整批行 —— 调用方要拿 stored_path 去清落盘字节
 * （字节是平台自己存的，只删元数据就是假删除）。顺序刻意是"先取清单、
 * 再删行"，让调用方在事务里删行、事务外删字节，两步都不会互相遮挡。
 * @returns {Array<object>} 被删除的附件行（含 stored_path）
 */
export function deleteForSession(tenantId, sessionId) {
  const rows = listAttachments(tenantId, sessionId, { limit: 5000 });
  run('DELETE FROM session_attachments WHERE tenant_id = ? AND session_id = ?', [tenantId, sessionId]);
  return rows;
}

/** 落库行 → 前端形状（**不含 stored_path**：它是部署机内部信息，不进响应） */
export function hydrate(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    mime: row.mime || '',
    bytes: Number(row.bytes) || 0,
    kind: row.kind,
    sha256: row.sha256 || '',
    createdAt: row.created_at,
  };
}
