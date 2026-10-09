/**
 * API Key 仓储 —— 给自动化/集成用的长期令牌。同样**只存哈希**。
 *
 * 与登录会话的区别：API Key 不绑定浏览器会话、不过期（除非指定），
 * 且带 `scopes`（逗号分隔）。scopes 为空表示"与所属用户的角色权限一致"。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { run, all, get } from '../../../data/db.mjs';
import { nowIso } from '../../../util/ids.mjs';

export function createApiKey({ id, userId, name, keyHash, scopes = [], expiresAt = null }) {
  run(
    `INSERT INTO api_keys (id, user_id, name, key_hash, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, String(name), keyHash, Array.isArray(scopes) ? scopes.join(',') : String(scopes || ''), expiresAt, nowIso()]
  );
  return getApiKey(id);
}

export function getApiKey(id) {
  return get('SELECT id, user_id, name, scopes, expires_at, last_used_at, created_at FROM api_keys WHERE id = ?', [id]);
}

/** 校验路径：先算 HMAC 再查表（与登录会话同一套思路） */
export function findByKeyHash(keyHash) {
  return get('SELECT * FROM api_keys WHERE key_hash = ?', [String(keyHash)]);
}

export function listForUser(userId) {
  return all(
    'SELECT id, user_id, name, scopes, expires_at, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  );
}

/**
 * 吊销 = 物理删除。
 * 理由：API Key 是"凭据"而不是"审计对象"；它的使用痕迹在 `audit_logs` 里有记录，
 * 留着一个失效的哈希只会让人误以为它还"存在"。真要留痕应写审计，而不是留行。
 */
export function revokeApiKey(userId, id) {
  return run('DELETE FROM api_keys WHERE user_id = ? AND id = ?', [userId, id]);
}

export function touchApiKey(id, at = nowIso()) {
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [at, id]);
}

/**
 * **物理删除**某用户的全部 API Key —— 删人时的清理，日常吊销请用 `revokeApiKey`。
 *
 * 与 `revokeApiKey` 同一条理由（key 是凭据不是审计对象）；这里额外因为
 * `api_keys.user_id` 带 `REFERENCES users(id)`（默认 RESTRICT）—— 不清就删不掉人。
 */
export function deleteForUser(userId) {
  const r = run('DELETE FROM api_keys WHERE user_id = ?', [String(userId)]);
  return r && r.changes ? Number(r.changes) : 0;
}

export function scopesOf(row) {
  if (!row || !row.scopes) return [];
  return String(row.scopes).split(',').map((s) => s.trim()).filter(Boolean);
}

export function isUsable(row, now = nowIso()) {
  if (!row) return false;
  if (!row.expires_at) return true;
  return String(row.expires_at) > String(now);
}
