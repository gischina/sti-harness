/**
 * 登录退避状态仓储（2026-10 安全评审 P0-4）。
 *
 * 账号名在**所有读写处统一规范化**（trim + 小写），与旧内存 Map 的 key
 * 口径一致；调用方传原始大小写也能命中同一行。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { run, get } from '../../../data/db.mjs';
import { nowIso } from '../../../util/ids.mjs';

const normUser = (username) => String(username == null ? '' : username).trim().toLowerCase();

export function getLockout(tenantId, username) {
  return get(
    `SELECT tenant_id, username, fail_count, locked_until, updated_at
       FROM login_lockout WHERE tenant_id = ? AND username = ?`,
    [String(tenantId), normUser(username)]
  );
}

/** 写入（或覆盖）某账号的失败计数与锁定截止时间；lockedUntil=null 表示当前未锁。 */
export function upsertLockout(tenantId, username, { failCount, lockedUntil = null }) {
  run(
    `INSERT INTO login_lockout (tenant_id, username, fail_count, locked_until, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, username) DO UPDATE SET
       fail_count   = excluded.fail_count,
       locked_until = excluded.locked_until,
       updated_at   = excluded.updated_at`,
    [String(tenantId), normUser(username), Math.max(0, Number(failCount) || 0), lockedUntil, nowIso()]
  );
}

/** 登录成功：整行删除。 */
export function clearLockout(tenantId, username) {
  return run('DELETE FROM login_lockout WHERE tenant_id = ? AND username = ?',
    [String(tenantId), normUser(username)]);
}
