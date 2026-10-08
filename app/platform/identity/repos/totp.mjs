/**
 * TOTP 两步验证仓储（迁移 0019）。
 *
 * 三组函数，对应三张表（表语义见 `0019_totp.sql` 的长注释）：
 *   · user_totp —— 每人至多一行；`secret_enc` 只进密文，`enabled_at` 区分"已登记/已启用"；
 *   · user_recovery_codes —— 一次性恢复码（只存 HMAC 哈希）；
 *   · login_challenges —— 两步登录的第二步票据（只存 HMAC 哈希）。
 *
 * 两条与安全直接相关的实现纪律：
 *   1. **步号推进用 CAS**（`advanceTotpStep`）：`UPDATE … WHERE last_used_step < ?`，
 *      影响行数为 0 就是"这个码已被用过（或更新）"—— 防重放不靠读-改写的竞态窗口。
 *   2. **挑战消费/计数同样用条件 UPDATE**：`useAttempt` 只在还有次数时 +1、
 *      `consume` 只消费未消费的 —— 把"一次性"落实在 SQL 条件里，而不是调用的自觉。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { run, all, get, tx } from '../../../data/db.mjs';
import { nowIso, newId } from '../../../util/ids.mjs';

// ── user_totp ────────────────────────────────────────────────────────────

export function getTotp(userId) {
  return get('SELECT * FROM user_totp WHERE user_id = ?', [String(userId)]);
}

/**
 * 写入（或覆盖）一条**未确认**的登记。
 * 已启用的行不能被这个函数覆盖（SQL 里带 `enabled_at IS NULL` 守卫）——
 * "重新开始登记"绝不等于"静默换掉一个正在生效的密钥"。
 * @returns {number} 影响行数（0 = 该用户已启用，调用方应报冲突）
 */
export function upsertPendingTotp(userId, secretEnc, at = nowIso()) {
  const r = run(
    `INSERT INTO user_totp (user_id, secret_enc, enabled_at, last_used_step, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       secret_enc  = excluded.secret_enc,
       enabled_at  = NULL,
       last_used_step = NULL,
       updated_at  = excluded.updated_at
     WHERE user_totp.enabled_at IS NULL`,
    [String(userId), secretEnc, at, at]
  );
  return r && r.changes ? Number(r.changes) : 0;
}

/**
 * 确认登记：写 enabled_at 与**确认时用的步号**（那个码从此刻起不能再用于登录 ——
 * 与 RFC 6238 §5.2 "已成功验证过的 OTP 不得二次接受"一致）。
 * @returns {number} 影响行数（0 = 没有待确认登记，调用方应报错）
 */
export function enableTotp(userId, { step, at = nowIso() } = {}) {
  const r = run(
    'UPDATE user_totp SET enabled_at = ?, last_used_step = ?, updated_at = ? WHERE user_id = ? AND enabled_at IS NULL',
    [at, step == null ? null : Number(step), at, String(userId)]
  );
  return r && r.changes ? Number(r.changes) : 0;
}

/**
 * 推进防重放步号（CAS）。登录/生成恢复码校验成功后调用。
 * @returns {number} 影响行数（0 = 步号 ≤ 已记录值 —— 该码是重放，调用方必须拒绝）
 */
export function advanceTotpStep(userId, step) {
  const r = run(
    'UPDATE user_totp SET last_used_step = ?, updated_at = ? WHERE user_id = ? AND enabled_at IS NOT NULL AND (last_used_step IS NULL OR last_used_step < ?)',
    [Number(step), nowIso(), String(userId), Number(step)]
  );
  return r && r.changes ? Number(r.changes) : 0;
}

export function deleteTotp(userId) {
  const r = run('DELETE FROM user_totp WHERE user_id = ?', [String(userId)]);
  return r && r.changes ? Number(r.changes) : 0;
}

/** 批量查"哪些用户已启用 TOTP" —— 用户列表页用（避免逐行查询） */
export function enabledUserIds(userIds = []) {
  const ids = (userIds || []).map(String).filter(Boolean);
  if (!ids.length) return new Set();
  const ph = ids.map(() => '?').join(',');
  const rows = all(
    `SELECT user_id FROM user_totp WHERE enabled_at IS NOT NULL AND user_id IN (${ph})`,
    ids
  );
  return new Set(rows.map((r) => r.user_id));
}

// ── user_recovery_codes ──────────────────────────────────────────────────

/** 整批替换某用户的恢复码（重新生成 = 旧的全作废）。空数组 = 只清除。 */
export function replaceRecoveryCodes(userId, hashes = [], at = nowIso()) {
  const uid = String(userId);
  tx(() => {
    run('DELETE FROM user_recovery_codes WHERE user_id = ?', [uid]);
    for (const h of hashes) {
      run(
        'INSERT INTO user_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)',
        [newId('rc'), uid, String(h), at]
      );
    }
  });
  return { count: hashes.length };
}

export function listRecoveryCodes(userId) {
  return all(
    'SELECT id, user_id, used_at, created_at FROM user_recovery_codes WHERE user_id = ? ORDER BY created_at, id',
    [String(userId)]
  );
}

export function countUnusedRecoveryCodes(userId) {
  const r = get(
    'SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
    [String(userId)]
  );
  return r ? Number(r.n) : 0;
}

/** 按哈希找**未使用**的恢复码（used_at 为空的才算候选） */
export function findUnusedRecoveryByHash(userId, codeHash) {
  return get(
    'SELECT id, user_id, code_hash FROM user_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    [String(userId), String(codeHash)]
  );
}

/** 消费一个恢复码（CAS：只有未使用的才能被标记） */
export function markRecoveryUsed(id, at = nowIso()) {
  const r = run(
    'UPDATE user_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL',
    [at, String(id)]
  );
  return r && r.changes ? Number(r.changes) : 0;
}

export function deleteRecoveryCodesForUser(userId) {
  const r = run('DELETE FROM user_recovery_codes WHERE user_id = ?', [String(userId)]);
  return r && r.changes ? Number(r.changes) : 0;
}

// ── login_challenges（第二步票据）────────────────────────────────────────

export function createChallenge({ id, userId, orgId, ticketHash, expiresAt, ip = '', ua = '' }) {
  run(
    `INSERT INTO login_challenges (id, user_id, org_id, ticket_hash, attempts, expires_at, consumed_at, ip, ua, created_at)
     VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?, ?)`,
    [id, String(userId), String(orgId), String(ticketHash), String(expiresAt), String(ip || ''), String(ua || '').slice(0, 400), nowIso()]
  );
}

export function findChallengeByTicketHash(ticketHash) {
  return get('SELECT * FROM login_challenges WHERE ticket_hash = ?', [String(ticketHash)]);
}

/** 作废某用户全部未消费的票据（签发新票据时调用：同时只有一个待验证窗口） */
export function invalidateOutstanding(userId, at = nowIso()) {
  const r = run(
    'UPDATE login_challenges SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL',
    [at, String(userId)]
  );
  return r && r.changes ? Number(r.changes) : 0;
}

/**
 * 记一次验证尝试（CAS：已消费/次数用尽后不再放行）。
 * **先扣次数再验码** —— 无论这次码对错，尝试机会都已被消耗，计数无法被"验错不记"绕过。
 * @returns {number} 影响行数（0 = 票据已消费或次数用尽，调用方必须拒绝）
 */
export function useAttempt(id, maxAttempts) {
  const r = run(
    'UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND attempts < ?',
    [String(id), Number(maxAttempts)]
  );
  return r && r.changes ? Number(r.changes) : 0;
}

/** 消费票据（CAS：一次性） */
export function consumeChallenge(id, at = nowIso()) {
  const r = run(
    'UPDATE login_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
    [at, String(id)]
  );
  return r && r.changes ? Number(r.changes) : 0;
}

/** 删人时的清理（外键 RESTRICT，必须先清） */
export function deleteChallengesForUser(userId) {
  const r = run('DELETE FROM login_challenges WHERE user_id = ?', [String(userId)]);
  return r && r.changes ? Number(r.changes) : 0;
}

/**
 * 清理已失效（已消费或已过期）且超过保留期的票据 —— 由 `session.purge` 任务顺带调用。
 * `orgId` 给定时只清本组织的（本表自带 org_id，无需子查询）。
 */
export function purgeStaleChallenges(keepDays = 7, { orgId = null } = {}) {
  const cutoff = new Date(Date.now() - keepDays * 86400 * 1000).toISOString();
  if (orgId) {
    return run(
      'DELETE FROM login_challenges WHERE org_id = ? AND (consumed_at IS NOT NULL OR expires_at < ?) AND created_at < ?',
      [String(orgId), nowIso(), cutoff]
    );
  }
  return run(
    'DELETE FROM login_challenges WHERE (consumed_at IS NOT NULL OR expires_at < ?) AND created_at < ?',
    [nowIso(), cutoff]
  );
}

/** 自检/测试辅助：某用户的票据行（含已消费） */
export function listChallengesForUser(userId) {
  return all(
    'SELECT id, user_id, org_id, attempts, expires_at, consumed_at, created_at FROM login_challenges WHERE user_id = ? ORDER BY created_at DESC',
    [String(userId)]
  );
}
