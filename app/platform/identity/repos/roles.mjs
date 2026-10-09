/**
 * 角色与绑定仓储。
 *
 * 设计：`roles` 是"角色定义"，`role_bindings` 是"谁在什么范围上拥有它"。
 * 内置 4 个角色（owner/admin/member/viewer）在**建组织时**物化到该组织下
 * （`org_id` 指向组织，`is_builtin=1`），这样多租户各自可改自己的显示名，
 * 而 `key` 保持稳定（权限判定只认 key）。
 *
 * ⚠️ `roles` 的 `UNIQUE (org_id, key)` 在 SQLite 里对 NULL org_id 不生效
 * （NULL 不参与唯一约束）—— 全局角色（org_id IS NULL）的冲突由本文件保证。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { run, all, get } from '../../../data/db.mjs';
import { newId, nowIso } from '../../../util/ids.mjs';
import { ROLE_MATRIX, ROLE_KEYS } from '../permissions.mjs';

/** 为一个组织物化内置角色（幂等：已存在的跳过） */
export function ensureBuiltinRoles(orgId) {
  const created = [];
  for (const key of ROLE_KEYS) {
    const exist = getRoleByKey(orgId, key);
    if (exist) continue;
    const id = newId('rol');
    const meta = ROLE_MATRIX[key];
    run(
      'INSERT INTO roles (id, org_id, key, name, description, is_builtin) VALUES (?, ?, ?, ?, ?, 1)',
      [id, orgId, key, meta.name, meta.description]
    );
    created.push(key);
  }
  return created;
}

export function listRoles(orgId) {
  return all('SELECT * FROM roles WHERE org_id = ? ORDER BY is_builtin DESC, key ASC', [orgId]);
}

export function getRoleByKey(orgId, key) {
  return get('SELECT * FROM roles WHERE org_id = ? AND key = ?', [orgId, String(key)]);
}

export function countRoles(orgId) {
  const r = get('SELECT COUNT(*) AS n FROM roles WHERE org_id = ?', [orgId]);
  return r ? Number(r.n) : 0;
}

// ── 绑定 ──────────────────────────────────────────────────────────────

/**
 * 建立绑定。**两道硬约束**（都不是"顺手加的"）：
 *
 *  1. `subjectType` 只认 `user` / `group`。0001 的注释写了这两种，就只允许这两种 ——
 *     未知值直接抛错，而不是先写进库、等判定层静默忽略（那正是 0007 之前 group 的处境）。
 *  2. **主体与角色必须同属一个组织**。以前没人校验：只要拿到一个别家的 user/group id，
 *     就能把别家的身份绑到本组织的角色上（或反过来）。判定层按角色所属组织算权限，
 *     于是这等于一次跨租户提权，且没有任何报错。
 */
export function bindRole({ subjectType = 'user', subjectId, roleId, scopeType = 'tenant', scopeId = null }) {
  const role = get('SELECT * FROM roles WHERE id = ?', [String(roleId)]);
  if (!role) throw new Error('角色不存在：' + roleId);

  const st = String(subjectType);
  if (st !== 'user' && st !== 'group') {
    throw new Error('未知 subjectType：' + subjectType + '（只允许 user / group）');
  }
  const table = st === 'user' ? 'users' : 'groups';
  const subject = get(`SELECT id, org_id FROM ${table} WHERE id = ?`, [String(subjectId)]);
  if (!subject) throw new Error((st === 'user' ? '用户' : '组') + '不存在：' + subjectId);
  if (subject.org_id !== role.org_id) {
    throw new Error('跨组织绑定被拒绝：主体的组织与角色所属组织不一致');
  }

  const exist = get(
    'SELECT * FROM role_bindings WHERE subject_type = ? AND subject_id = ? AND role_id = ? AND scope_type = ? AND IFNULL(scope_id, \'\') = IFNULL(?, \'\')',
    [st, String(subjectId), String(roleId), scopeType, scopeId]
  );
  if (exist) return exist;   // 幂等
  const id = newId('rb');
  run(
    'INSERT INTO role_bindings (id, subject_type, subject_id, role_id, scope_type, scope_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, st, String(subjectId), String(roleId), scopeType, scopeId, nowIso()]
  );
  return get('SELECT * FROM role_bindings WHERE id = ?', [id]);
}

export function unbindRole(id) {
  return run('DELETE FROM role_bindings WHERE id = ?', [id]);
}

export function bindingsForSubject(subjectType, subjectId) {
  return all('SELECT * FROM role_bindings WHERE subject_type = ? AND subject_id = ?', [subjectType, subjectId]);
}

/**
 * 取某用户**生效**的角色 key 列表 = 直接绑定 ∪ 所属组的绑定。
 *
 * 只取 `scope_type='tenant'` 的全局绑定 —— 更细的范围（部门/知识库）在 M2/M4 引入时
 * 再按 scope 展开，现在不假装支持。
 *
 * ⚠️ 这里以前只看 `subject_type='user'`，所以组绑定写进库也不会生效（0007 之前的静默空转）。
 * 组那一支额外要求 `g.org_id = r.org_id`：即使库里有脏数据（跨组织的历史绑定），
 * 也**不会**因此被算成权限 —— 纵深防御的第二层。
 *
 * 这是**认证路径上的热查询**（每个请求都会跑）—— 索引
 * `idx_role_bindings_subject` / `idx_group_members_user` 都吃得上，别随手改成多次往返。
 */
export function roleKeysForUser(userId) {
  const rows = all(
    `SELECT DISTINCT r.key AS key
       FROM role_bindings b
       JOIN roles r ON r.id = b.role_id
      WHERE b.scope_type = 'tenant'
        AND (
             (b.subject_type = 'user' AND b.subject_id = ?)
          OR (b.subject_type = 'group' AND EXISTS (
                SELECT 1
                  FROM group_members gm
                  JOIN groups g ON g.id = gm.group_id
                 WHERE gm.group_id = b.subject_id
                   AND gm.user_id = ?
                   AND g.org_id = r.org_id
             ))
        )
      ORDER BY r.key ASC`,
    [String(userId), String(userId)]
  );
  return rows.map((r) => r.key);
}

/** 批量版（列表页用）：一次查询拿到「用户 → 生效角色」。避免每人一次往返。 */
export function roleKeysForUsers(userIds = []) {
  const ids = userIds.map(String);
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const holes = ids.map(() => '?').join(',');
  // 注意：组那一支的 `b.subject_id` 是**组 id**，不是用户 id ——
  // 必须从 group_members 取 user_id。写成 `b.subject_id AS user_id` 会把组 id 混进
  // 用户列表（键对不上就静默丢角色，是最难查的那类"好像生效了其实没有"）。
  const rows = all(
    `SELECT DISTINCT u AS user_id, key FROM (
         SELECT b.subject_id AS u, r.key AS key
           FROM role_bindings b
           JOIN roles r ON r.id = b.role_id
          WHERE b.scope_type = 'tenant' AND b.subject_type = 'user'
            AND b.subject_id IN (${holes})
         UNION ALL
         SELECT gm.user_id AS u, r.key AS key
           FROM role_bindings b
           JOIN roles    r  ON r.id = b.role_id
           JOIN groups   g  ON g.id = b.subject_id
           JOIN group_members gm ON gm.group_id = g.id
          WHERE b.scope_type = 'tenant' AND b.subject_type = 'group'
            AND g.org_id = r.org_id
            AND gm.user_id IN (${holes})
       )
      ORDER BY key ASC`,
    [...ids, ...ids]
  );
  for (const r of rows) {
    const list = out.get(r.user_id);
    if (list && !list.includes(r.key)) list.push(r.key);
  }
  return out;
}

/**
 * 某用户在**指定范围类型**上生效的库级/范围级角色。
 *
 * 与 `roleKeysForUser` 的关系：那个是**租户级**（`scope_type='tenant'`）的角色，
 * 决定"这个人在整个组织里能做什么"；本函数是**范围级**（如
 * `scope_type='knowledge_base'`）的角色，决定"这个人在那一个库上能做什么"。
 * 两者在判定层**取并集**（见 `platform/knowledge/visibility.mjs`），不是取交集 ——
 * 且都遵循同一条安全线：范围级授权只能**在范围内**放宽，绝不影响范围外的资源。
 *
 * 返回**逐 scope 展开**（`{scopeId, roleKey}`）而不是聚合的角色列表：
 * 调用方（知识库列表）需要一次拿到"我对哪些库、各有什么角色"，
 * 按库分组后逐库判定；聚合掉 scope 就只能"整租户一个角色集"，
 * 那正是库级 ACL 要解决的问题本身。
 *
 * 组展开与 `roleKeysForUser` 同构，含同样的纵深防御（`g.org_id = r.org_id`）：
 * 库里若有跨组织的脏绑定，也不会被算成权限。
 *
 * @param {string} userId
 * @param {string} scopeType  例：'knowledge_base'
 * @returns {Array<{scopeId:string, roleKey:string}>}
 */
export function scopedRolesForUser(userId, scopeType) {
  const rows = all(
    `SELECT DISTINCT b.scope_id AS scope_id, r.key AS key
       FROM role_bindings b
       JOIN roles r ON r.id = b.role_id
      WHERE b.scope_type = ?
        AND IFNULL(b.scope_id, '') <> ''
        AND (
             (b.subject_type = 'user' AND b.subject_id = ?)
          OR (b.subject_type = 'group' AND EXISTS (
                SELECT 1
                  FROM group_members gm
                  JOIN groups g ON g.id = gm.group_id
                 WHERE gm.group_id = b.subject_id
                   AND gm.user_id = ?
                   AND g.org_id = r.org_id
             ))
        )
      ORDER BY b.scope_id ASC, r.key ASC`,
    [String(scopeType), String(userId), String(userId)]
  );
  return rows.map((r) => ({ scopeId: r.scope_id, roleKey: r.key }));
}

/**
 * 某范围（如某一个知识库）上的**全部**授权，带角色名与主体名 ——
 * 前端"这个库授权给了谁"页直接用。
 *
 * 两条纪律：
 *   · 必须 `JOIN roles ... WHERE r.org_id = ?` —— 范围 id 是全局唯一的字符串，
 *     若不过滤组织，一个拿到别家库 id 的人就能列出别家的授权名单（信息泄漏）。
 *   · 用户与组两种主体都要能显示**名字**：只 join users 的话组会显示成裸 id，
 *     管理员看到一行没有名字的授权，只会以为那是脏数据（与 `bindingsWithRole` 同因）。
 */
export function bindingsForScope(orgId, scopeType, scopeId) {
  return all(
    `SELECT b.*, r.key AS role_key, r.name AS role_name,
            u.username, u.display_name, g.name AS group_name
       FROM role_bindings b
       JOIN roles r ON r.id = b.role_id
       LEFT JOIN users  u ON u.id = b.subject_id AND b.subject_type = 'user'
       LEFT JOIN groups g ON g.id = b.subject_id AND b.subject_type = 'group'
      WHERE r.org_id = ?
        AND b.scope_type = ?
        AND IFNULL(b.scope_id, '') = IFNULL(?, '')
      ORDER BY b.created_at ASC`,
    [String(orgId), String(scopeType), String(scopeId)]
  );
}

/** 某条绑定所属的组织（经 role_id 反查）—— 用于撤销时的归属校验 */
export function orgIdOfBinding(id) {
  const r = get(
    `SELECT r.org_id AS org_id
       FROM role_bindings b
       JOIN roles r ON r.id = b.role_id
      WHERE b.id = ?`,
    [String(id)]
  );
  return r ? r.org_id : null;
}

/**
 * 带角色名与主体名的绑定列表（前端"谁能管什么"页用）。
 *
 * ⚠️ **只列租户级绑定**（`scope_type='tenant'`）。这个页面的语义是"组织里的角色分配"；
 * 库级绑定（`scope_type='knowledge_base'`）有自己的页面与接口。若不过滤，
 * 一个"给财务组授予了财务库的查看权"会出现在组织角色页上，管理员会以为
 * 财务组在**组织级**被授了角色 —— 一个页面混两种范围，是权限系统里最容易出错的呈现。
 *
 * 两种主体都要能显示出**名字**：只 join users 的话，组绑定会显示成一个裸 id，
 * 管理员看见一行没有名字的绑定，只会以为是脏数据。
 */
export function bindingsWithRole(orgId) {
  return all(
    `SELECT b.*, r.key AS role_key, r.name AS role_name,
            u.username, u.display_name, g.name AS group_name
       FROM role_bindings b
       JOIN roles r ON r.id = b.role_id
       LEFT JOIN users  u ON u.id = b.subject_id AND b.subject_type = 'user'
       LEFT JOIN groups g ON g.id = b.subject_id AND b.subject_type = 'group'
      WHERE r.org_id = ? AND b.scope_type = 'tenant'
      ORDER BY b.created_at ASC`,
    [orgId]
  );
}

/**
 * 组织内某角色的**持有人数** = 生效该角色的**用户**去重计数（直接持有 ∪ 凭组持有）。
 *
 * 为什么必须穿透组：这个数字唯一的用途是「不许把最后一个 owner 弄没」。
 * 只数 `subject_type='user'` 的话，一个「owner 只挂在组上」的组织会被算成 0 个持有人 ——
 * 于是本来是合法的操作（例如给某人改角色）会被误拒；反过来，
 * 如果谁把组里的 owner 角色摘掉，也会因为"看不出少了人"而放行，把组织锁死。
 * 安全性判定必须按**生效**算，不能按"写在谁名下"算。
 */
export function countHolders(orgId, roleKey) {
  return countHoldersInner(orgId, roleKey, false);
}

/**
 * 同 `countHolders`，但只数**在用**（`users.status='active'`）的人。
 *
 * 为什么需要单独一个：把最后一个 owner **停用**并不会改动任何绑定，
 * 所以"绑定计数"看不出来 —— 但停用之后他连登录都做不到，组织事实上没人管了。
 * 停用保护必须按"还能不能用"算，不能按"名字还挂不挂在上面"算。
 */
export function countActiveHolders(orgId, roleKey) {
  return countHoldersInner(orgId, roleKey, true);
}

function countHoldersInner(orgId, roleKey, activeOnly) {
  const active = activeOnly ? "AND EXISTS (SELECT 1 FROM users usr WHERE usr.id = x.u AND usr.status = 'active')" : '';
  const r = get(
    `SELECT COUNT(DISTINCT u) AS n FROM (
         SELECT b.subject_id AS u
           FROM role_bindings b
           JOIN roles r ON r.id = b.role_id
          WHERE r.org_id = ? AND r.key = ? AND b.scope_type = 'tenant'
            AND b.subject_type = 'user'
         UNION
         SELECT gm.user_id AS u
           FROM role_bindings b
           JOIN roles r ON r.id = b.role_id
           JOIN groups g ON g.id = b.subject_id
           JOIN group_members gm ON gm.group_id = g.id
          WHERE r.org_id = ? AND r.key = ? AND b.scope_type = 'tenant'
            AND b.subject_type = 'group' AND g.org_id = r.org_id
       ) x
      WHERE 1 = 1 ${active}`,
    [orgId, roleKey, orgId, roleKey]
  );
  return r ? Number(r.n) : 0;
}
