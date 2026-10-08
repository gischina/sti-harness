/**
 * 会话令牌仓储 —— 表里**只有哈希**，没有任何地方存明文令牌。
 *
 * 与 `app/data/repositories/sessions.mjs`（那是 **Agent 会话**，`agent_sessions`）
 * 是两回事：本文件管的是 **登录会话**（`auth_sessions`）。命名上刻意用 `authSessions`
 * 区分，避免调用方搞混。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { run, all, get } from '../../../data/db.mjs';
import { nowIso } from '../../../util/ids.mjs';

export function createAuthSession({ id, userId, tokenHash, expiresAt, ip = '', ua = '' }) {
  run(
    `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, ip, ua, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, tokenHash, expiresAt, String(ip || ''), String(ua || '').slice(0, 400), nowIso()]
  );
  return getAuthSession(id);
}

export function getAuthSession(id) {
  return get('SELECT * FROM auth_sessions WHERE id = ?', [id]);
}

/**
 * 按令牌哈希查会话。**校验路径只走这里**（先 HMAC 再查），
 * 因此数据库里存在的哈希不能直接当令牌用 —— 缺 masterSecret 就算不出它。
 */
export function findByTokenHash(tokenHash) {
  return get('SELECT * FROM auth_sessions WHERE token_hash = ?', [String(tokenHash)]);
}

export function revoke(id, at = nowIso()) {
  return run('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [at, id]);
}

export function revokeAllForUser(userId, at = nowIso()) {
  return run('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [at, userId]);
}

/**
 * **物理删除**某用户的全部会话记录 —— 删人时的清理，日常"踢下线"请用 `revokeAllForUser`。
 *
 * 为什么删人必须真删而不是只置 `revoked_at`：`auth_sessions.user_id` 带
 * `REFERENCES users(id)`，外键是默认的 RESTRICT —— 这些行还在，`users` 那行就删不掉。
 * 保留已吊销的历史行对"已删除的人"没有意义（他不会再登录了，行只是拖慢清理）。
 */
export function deleteForUser(userId) {
  const r = run('DELETE FROM auth_sessions WHERE user_id = ?', [String(userId)]);
  return r && r.changes ? Number(r.changes) : 0;
}

/**
 * 列出某用户当前有效的登录会话。
 *
 * ⚠️ 这是 A2(b) 那批"有实现没出口"里**唯一被保留**的一项 —— 它只被 `test-core` 用到
 * （验证"删人时登录会话被一起清掉"），没有业务出口。它与 `_internals`/`shims` 同类，
 * 属**刻意保留**而非忘了接。
 * 为什么不干脆删掉：删了那条断言只能改用 `findByTokenHash` 逐个去猜哪个哈希属于他，
 * 测的东西就从"查这个人的会话"退化成"猜哈希"了 —— 断言还在，但证明力没了。
 */
export function listActiveForUser(userId) {
  return all(
    'SELECT id, user_id, expires_at, ip, ua, created_at FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
    [userId]
  );
}

export function countActive() {
  const r = get('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ?', [nowIso()]);
  return r ? Number(r.n) : 0;
}

/**
 * 清理已过期/已吊销的会话记录（保留最近 N 天便于审计追溯）。
 *
 * `orgId` 给定时**只清该组织的**（经 `users.org_id` 反查）—— 定时任务按组织触发，
 * 若不加这层收窄，"某个组织的清理任务"会顺手删掉**全平台所有组织**的会话，是越界副作用。
 * 不给 `orgId` 则全表清（供一次性手工清理 / 迁移）。
 *
 * tenant-ok: `auth_sessions` 本身不带 `tenant_id`（登录记录只关联 `user_id`），
 * 故这里通过 `users.org_id` 子查询收窄到组织。
 */
export function purgeStale(keepDays = 7, { orgId = null } = {}) {
  const cutoff = new Date(Date.now() - keepDays * 86400 * 1000).toISOString();
  if (orgId) {
    return run(
      `DELETE FROM auth_sessions
        WHERE (revoked_at IS NOT NULL OR expires_at < ?) AND created_at < ?
          AND user_id IN (SELECT id FROM users WHERE org_id = ?)`,
      [nowIso(), cutoff, String(orgId)]
    );
  }
  return run(
    'DELETE FROM auth_sessions WHERE (revoked_at IS NOT NULL OR expires_at < ?) AND created_at < ?',
    [nowIso(), cutoff]
  );
}

/** 会话是否仍然有效（未吊销且未过期）—— 判定集中在仓储层，避免各调用点各写一遍 */
export function isUsable(row, now = nowIso()) {
  if (!row) return false;
  if (row.revoked_at) return false;
  return String(row.expires_at) > String(now);
}
