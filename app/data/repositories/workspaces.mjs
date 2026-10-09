/**
 * 工作区仓储。
 *
 * 纪律与 sessions.mjs 完全同构：**所有查询强制带 tenant_id 过滤**
 * （仓储层统一注入，调用方无法绕过）。工作区是 0021 引入的平台侧组织概念：
 * 上游内核没有工作区实体，这里的每一行都只属于本平台。
 *
 * 0.21.6：`visibility` 列随工作区权限模块一起删掉了（迁移 0023）。
 * 工作区现在是**纯组织容器** —— 一个行里只剩下"叫什么、指向哪个目录、归谁建"。
 *
 * 0.21.9：`is_default` 加上（迁移 0024），随「未分组」一起进来。它标记那个
 * **兜底工作区** —— 删工作区时会话落进它，因此它不能改名、不能删除。
 * 「至多一条」这条不变量**不在 schema 里**（没有唯一索引、没有触发器），
 * 由服务层维持：`ensureDefaultWorkspace` 播种时设，`updateWorkspace` /
 * `deleteWorkspace` 拦。理由见 0024 头注释末段 —— 业务规则留在可读可测的那一层。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { run, all, get } from '../db.mjs';
import { newId, nowIso } from '../../util/ids.mjs';

export function createWorkspaceRow({
  tenantId, ownerUserId = null, name, cwd = '', description = '', isDefault = false,
}) {
  const id = newId('wsp');
  const at = nowIso();
  run(
    `INSERT INTO workspaces
       (id, tenant_id, owner_user_id, name, cwd, description, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, tenantId, ownerUserId, name, cwd, description, isDefault ? 1 : 0, at, at]
  );
  return getWorkspace(tenantId, id);
}

export function getWorkspace(tenantId, id) {
  return get('SELECT * FROM workspaces WHERE tenant_id = ? AND id = ?', [tenantId, id]);
}

export function listWorkspaces(tenantId) {
  return all('SELECT * FROM workspaces WHERE tenant_id = ? AND archived_at IS NULL ORDER BY updated_at DESC', [tenantId]);
}

const TOUCHABLE = ['name', 'cwd', 'description'];

export function touchWorkspace(tenantId, id, patch = {}) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (TOUCHABLE.includes(k)) {
      fields.push(k + ' = ?');
      params.push(v);
    }
  }
  if (!fields.length) return getWorkspace(tenantId, id);
  fields.push('updated_at = ?');
  params.push(nowIso(), tenantId, id);
  run('UPDATE workspaces SET ' + fields.join(', ') + ' WHERE tenant_id = ? AND id = ?', params);
  return getWorkspace(tenantId, id);
}

/**
 * 这个租户的兜底工作区（`is_default = 1`）。每租户至多一条，由服务层维持。
 * @returns {object|undefined} 没有（新装、还没播种）时返回 undefined
 */
export function getDefaultWorkspace(tenantId) {
  return get(
    'SELECT * FROM workspaces WHERE tenant_id = ? AND is_default = 1 AND archived_at IS NULL LIMIT 1',
    [tenantId]
  );
}

/**
 * 把一个工作区标成兜底工作区（`is_default = 1`）。
 *
 * ⚠️ 它**不负责清掉别的行**：本项目的做法是"`is_default = 1` 的行每租户至多一条"
 * 由服务层维持（播种时设、改名/删除时拦），所以这里不做"先清零再置一"。
 * 如果哪天有人从别的路径调它，请先把那两处判据一起看一遍。
 * @returns {boolean} 是否改到了行
 */
export function markDefaultWorkspace(tenantId, id) {
  const r = run(
    'UPDATE workspaces SET is_default = 1, updated_at = ? WHERE tenant_id = ? AND id = ?',
    [nowIso(), tenantId, id]
  );
  return r.changes > 0;
}

/**
 * 删除工作区行本体。**不级联**：挂在下面的会话原地保留，
 * 由调用方先把它们的 workspace_id 改成**兜底工作区**（0.21.9 起不再有"未分组"）。
 * @returns {boolean} 是否真的删了
 */
export function deleteWorkspaceRow(tenantId, id) {
  const r = run('DELETE FROM workspaces WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  return r.changes > 0;
}

/**
 * 把一个工作区里的会话**整体搬进另一个工作区**（删工作区时用）。
 * @param {string|null} toWorkspaceId 目标工作区；给 null 会把会话置空归属 ——
 *   **不要这么用**（0.21.9 起"空归属"不再是一个合法归宿，服务层已把它拦在删除之前）。
 *   参数留着是为了让"移到哪"显式化，而不是在这里偷偷写死。
 * @returns {number} 搬动的会话数
 */
export function moveSessionsTo(tenantId, fromWorkspaceId, toWorkspaceId) {
  const r = run(
    `UPDATE agent_sessions
        SET workspace_id = ?, updated_at = ?
      WHERE tenant_id = ? AND workspace_id = ? AND archived_at IS NULL`,
    [toWorkspaceId, nowIso(), tenantId, fromWorkspaceId]
  );
  return r.changes;
}

/**
 * 把仍**没有归属**的会话挂进指定工作区（迁移 0024 之后的启动对账）。
 *
 * 为什么还要有它：0024 里那段 UPDATE 够不着"迁移跑的时候还没有工作区"的租户 ——
 * 那种租户的默认工作区是**启动播种**才建的（main.mjs：migrate 在前、播种在后）。
 * 播种完调一次这里，空归属就清零了。幂等，且没有空行时是一条不写库的 UPDATE。
 * @returns {number} 挂靠的会话数
 */
export function attachOrphanSessions(tenantId, workspaceId) {
  const r = run(
    `UPDATE agent_sessions
        SET workspace_id = ?, updated_at = ?
      WHERE tenant_id = ? AND workspace_id IS NULL AND archived_at IS NULL`,
    [workspaceId, nowIso(), tenantId]
  );
  return r.changes;
}

/** 各工作区的会话数（含全部未归档会话；一次查询，列表页别逐个数） */
export function countSessionsByWorkspace(tenantId) {
  const rows = all(
    `SELECT workspace_id AS wsId, COUNT(*) AS n
       FROM agent_sessions
      WHERE tenant_id = ? AND archived_at IS NULL AND workspace_id IS NOT NULL
      GROUP BY workspace_id`,
    [tenantId]
  );
  const map = new Map();
  for (const r of rows) map.set(r.wsId, Number(r.n));
  return map;
}
