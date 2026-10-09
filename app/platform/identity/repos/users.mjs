/**
 * 用户仓储。
 *
 * 纪律：
 *   · 唯一性是 `(org_id, username)` —— 同名账号可存在于不同组织；
 *   · **不提供返回 pwd_hash / pwd_salt 的"顺手查询"**，只有 `getUserAuth()` 一个
 *     明确命名的函数会带出这两个字段，且调用点只有登录路径。避免"列表接口顺手
 *     把哈希带出去"这类事故。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { run, all, get } from '../../../data/db.mjs';
import { newId, nowIso } from '../../../util/ids.mjs';

/** 对外可安全暴露的列（**不含** pwd_hash / pwd_salt） */
const PUBLIC_COLS = 'id, org_id, dept_id, username, display_name, status, created_at, last_login_at';

export function createUser({ orgId, username, displayName, deptId = null, pwdHash, pwdSalt }) {
  const id = newId('usr');
  const at = nowIso();
  run(
    `INSERT INTO users (id, org_id, dept_id, username, display_name, pwd_hash, pwd_salt, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [id, orgId, deptId, String(username), String(displayName), String(pwdHash), String(pwdSalt), at]
  );
  return getUser(orgId, id);
}

export function getUser(orgId, id) {
  return get('SELECT ' + PUBLIC_COLS + ' FROM users WHERE org_id = ? AND id = ?', [orgId, id]);
}

/** 跨组织按 id 取用户（登录后解析会话、审计记录用）。不带口令字段。 */
export function getUserById(id) {
  return get('SELECT ' + PUBLIC_COLS + ' FROM users WHERE id = ?', [id]);
}

export function getUserByUsername(orgId, username) {
  return get('SELECT ' + PUBLIC_COLS + ' FROM users WHERE org_id = ? AND username = ?', [orgId, String(username)]);
}

/**
 * **唯一**会返回口令哈希的函数。仅供登录校验使用。
 * 单独命名是为了让"谁碰了哈希"在 code review 时一眼可见。
 */
export function getUserAuth(orgId, username) {
  return get(
    'SELECT id, org_id, status, pwd_hash, pwd_salt FROM users WHERE org_id = ? AND username = ?',
    [orgId, String(username)]
  );
}

export function listUsers(orgId, { limit = 100, offset = 0 } = {}) {
  return all(
    'SELECT ' + PUBLIC_COLS + ' FROM users WHERE org_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    [orgId, Number(limit) || 100, Number(offset) || 0]
  );
}

export function countUsers(orgId) {
  const r = get('SELECT COUNT(*) AS n FROM users WHERE org_id = ?', [orgId]);
  return r ? Number(r.n) : 0;
}

/**
 * 每个部门的成员数（`Map<deptId, n>`）—— 一次查询拿全，避免"列出 N 个部门就打 N 次库"。
 *
 * 为什么显式 `dept_id IS NOT NULL`：`dept_id = NULL` 在 SQL 里既不等于任何值也不等于自己，
 * 靠 `GROUP BY` 自然会得到一行 `null` 分组。我们不把它当"一个部门"，所以在 SQL 里就排除，
 * 而不是让调用方每次记得过滤。
 */
export function countUsersByDept(orgId) {
  const rows = all(
    'SELECT dept_id, COUNT(*) AS n FROM users WHERE org_id = ? AND dept_id IS NOT NULL GROUP BY dept_id',
    [orgId]
  );
  const m = new Map();
  for (const r of rows) m.set(r.dept_id, Number(r.n) || 0);
  return m;
}

/** 白名单式更新（不接受任意字段，避免调用方拼出危险 UPDATE） */
export function updateUser(orgId, id, patch = {}) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (['display_name', 'dept_id', 'status'].includes(k)) {
      fields.push(k + ' = ?');
      params.push(v);
    }
  }
  if (!fields.length) return getUser(orgId, id);
  params.push(orgId, id);
  run('UPDATE users SET ' + fields.join(', ') + ' WHERE org_id = ? AND id = ?', params);
  return getUser(orgId, id);
}

export function setUserPassword(id, pwdHash, pwdSalt) {
  run('UPDATE users SET pwd_hash = ?, pwd_salt = ? WHERE id = ?', [String(pwdHash), String(pwdSalt), id]);
}

export function touchLogin(id, at = nowIso()) {
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [at, id]);
}

export function deleteUser(orgId, id) {
  return run('DELETE FROM users WHERE org_id = ? AND id = ?', [orgId, id]);
}
