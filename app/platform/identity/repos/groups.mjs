/**
 * 用户组仓储（P0-D #8）。
 *
 * 组是**权限载体**：`role_bindings.subject_type='group'` 指的必须是这里真实存在的组，
 * 否则那条绑定就是一条不生效的噪声（这正是 0007 迁移之前的状态）。
 *
 * 隔离纪律：所有查询都带 `org_id`，且**同一组织**是硬约束 ——
 *   · `addMember` 校验成员属于本组织（不能把别家的人拉进来）；
 *   · `bindRole`（在 roles.mjs）校验组的 org 与角色的 org 相同（不能借别家的角色）。
 * 这两条合起来，组就不可能成为跨租户提权的跳板。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { run, all, get } from '../../../data/db.mjs';
import { newId, nowIso } from '../../../util/ids.mjs';

export function createGroup({ orgId, name, description = '' }) {
  const n = String(name || '').trim();
  if (!n) throw new Error('组名不能为空');
  const id = newId('grp');
  run(
    'INSERT INTO groups (id, org_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, orgId, n, String(description || ''), nowIso()]
  );
  return getGroup(orgId, id);
}

export function listGroups(orgId) {
  return all(
    `SELECT g.*, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
       FROM groups g
      WHERE g.org_id = ?
      ORDER BY g.created_at ASC, g.name ASC`,
    [orgId]
  );
}

export function getGroup(orgId, id) {
  return get('SELECT * FROM groups WHERE org_id = ? AND id = ?', [orgId, String(id)]);
}

export function getGroupByName(orgId, name) {
  return get('SELECT * FROM groups WHERE org_id = ? AND name = ?', [orgId, String(name)]);
}

export function updateGroup(orgId, id, { name, description } = {}) {
  const fields = [];
  const params = [];
  if (name != null) { fields.push('name = ?'); params.push(String(name).trim()); }
  if (description != null) { fields.push('description = ?'); params.push(String(description)); }
  if (!fields.length) return getGroup(orgId, id);
  params.push(String(orgId), String(id));
  run(`UPDATE groups SET ${fields.join(', ')} WHERE org_id = ? AND id = ?`, params);
  return getGroup(orgId, id);
}

/** 删组：成员关系必须一起清（否则留下孤儿成员行，将来重建同名组会"借尸还魂"带进旧成员）。 */
export function deleteGroup(orgId, id) {
  run('DELETE FROM group_members WHERE group_id = ?', [String(id)]);
  const r = run('DELETE FROM groups WHERE org_id = ? AND id = ?', [String(orgId), String(id)]);
  return { changes: r && r.changes ? Number(r.changes) : 0 };
}

// ── 成员 ──────────────────────────────────────────────────────────────

/**
 * 加成员。**必须是本组织的人** —— 不校验的话，一个跨组织的 user_id 会被写进来，
 * 而组的角色绑定是按组的 org 判定的，等于隔空给外人授权。
 */
export function addMember({ orgId, groupId, userId }) {
  const g = getGroup(orgId, groupId);
  if (!g) return { ok: false, error: '组不存在：' + groupId };
  const u = get('SELECT id, org_id FROM users WHERE id = ?', [String(userId)]);
  if (!u) return { ok: false, error: '用户不存在：' + userId };
  if (u.org_id !== String(orgId)) return { ok: false, error: '成员必须属于本组织（跨组织加入组被拒绝）' };

  const exist = get('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', [String(groupId), String(userId)]);
  if (exist) return { ok: true, id: exist.id, created: false };
  const id = newId('gm');
  run(
    'INSERT INTO group_members (id, group_id, user_id, created_at) VALUES (?, ?, ?, ?)',
    [id, String(groupId), String(userId), nowIso()]
  );
  return { ok: true, id, created: true };
}

export function removeMember({ orgId, groupId, userId }) {
  const g = getGroup(orgId, groupId);
  if (!g) return { ok: false, error: '组不存在：' + groupId };
  const r = run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [String(groupId), String(userId)]);
  return { ok: true, removed: r && r.changes ? Number(r.changes) : 0 };
}

/**
 * 把某用户从**所有**组里移除 —— 删人时的清理。返回移除的成员关系条数。
 *
 * 为什么不能只删 `users` 那行让外键级联：`group_members.user_id` 带
 * `REFERENCES users(id)` 且外键为默认 RESTRICT（**没有** ON DELETE CASCADE）——
 * 关系还在时本人根本删不掉。顺序必须"先清关系、再删本人"。
 */
export function removeMembershipsForUser(userId) {
  const r = run('DELETE FROM group_members WHERE user_id = ?', [String(userId)]);
  return r && r.changes ? Number(r.changes) : 0;
}

/** 整组替换成员（PUT 的语义） */
export function setMembers({ orgId, groupId, userIds = [] }) {
  const g = getGroup(orgId, groupId);
  if (!g) return { ok: false, error: '组不存在：' + groupId };
  const want = [...new Set(userIds.map(String))];
  run('DELETE FROM group_members WHERE group_id = ?', [String(groupId)]);
  const added = [];
  const rejected = [];
  for (const uid of want) {
    const r = addMember({ orgId, groupId, userId: uid });
    if (r.ok) added.push(uid); else rejected.push({ userId: uid, error: r.error });
  }
  return { ok: true, added, rejected };
}

/** 带用户信息的成员列表（前端组页直接用） */export function membersOf(orgId, groupId) {
  return all(
    `SELECT m.user_id, m.created_at, u.username, u.display_name, u.status
       FROM group_members m
       JOIN groups g ON g.id = m.group_id
       JOIN users  u ON u.id = m.user_id
      WHERE g.org_id = ? AND m.group_id = ?
      ORDER BY u.username ASC`,
    [String(orgId), String(groupId)]
  );
}

export function memberIdsOf(orgId, groupId) {
  return membersOf(orgId, groupId).map((r) => r.user_id);
}

export function countGroups(orgId) {
  const r = get('SELECT COUNT(*) AS n FROM groups WHERE org_id = ?', [String(orgId)]);
  return r ? Number(r.n) : 0;
}

/** 某用户所属的全部组（单用户场景） */
export function groupsForUser(orgId, userId) {
  return all(
    `SELECT g.id, g.name
       FROM group_members m
       JOIN groups g ON g.id = m.group_id
      WHERE g.org_id = ? AND m.user_id = ?
      ORDER BY g.name ASC`,
    [String(orgId), String(userId)]
  );
}

/**
 * 批量取「用户 → 所属组」（用户列表页用）。
 * 一次查询而不是每人一次 —— 列表页的 N+1 在 100 人时就是 100 次往返。
 * @returns {Map<string, Array<{id:string,name:string}>>}
 */
export function groupsForUsers(orgId, userIds = []) {
  const ids = userIds.map(String);
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const holes = ids.map(() => '?').join(',');
  const rows = all(
    `SELECT m.user_id, g.id, g.name
       FROM group_members m
       JOIN groups g ON g.id = m.group_id
      WHERE g.org_id = ? AND m.user_id IN (${holes})
      ORDER BY g.name ASC`,
    [String(orgId), ...ids]
  );
  for (const r of rows) {
    const list = out.get(r.user_id);
    if (list) list.push({ id: r.id, name: r.name });
  }
  return out;
}

/** 组持有的角色 key（前端展示 + owner 保护判定要用） */
export function roleKeysOfGroup(orgId, groupId) {
  return all(
    `SELECT r.key AS key
       FROM role_bindings b
       JOIN roles  r ON r.id = b.role_id
       JOIN groups g ON g.id = b.subject_id
      WHERE b.subject_type = 'group' AND b.subject_id = ? AND g.org_id = ?
      ORDER BY r.key ASC`,
    [String(groupId), String(orgId)]
  ).map((r) => r.key);
}
