/**
 * 组织与部门仓储。
 *
 * 纪律：**组织是所有数据的租户边界**（`agent_sessions.tenant_id`、`events`、
 * `audit_logs` 等都以 org 的 id 作为 tenant）。本文件的读写函数都要求显式传 orgId，
 * 不做"取全部"的接口 —— 从接口形状上杜绝跨租户误用。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { run, all, get } from '../../../data/db.mjs';
import { newId, nowIso } from '../../../util/ids.mjs';

// ── 组织 ──────────────────────────────────────────────────────────────

export function createOrg({ name, slug, parentId = null }) {
  const id = newId('org');
  run(
    'INSERT INTO orgs (id, name, slug, parent_id, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, String(name), String(slug), parentId, nowIso()]
  );
  return getOrg(id);
}

export function getOrg(id) {
  return get('SELECT * FROM orgs WHERE id = ?', [id]);
}

export function getOrgBySlug(slug) {
  return get('SELECT * FROM orgs WHERE slug = ?', [String(slug)]);
}

export function listOrgs() {
  return all('SELECT * FROM orgs ORDER BY created_at ASC');
}

export function countOrgs() {
  const r = get('SELECT COUNT(*) AS n FROM orgs');
  return r ? Number(r.n) : 0;
}

/**
 * 说明（体检 §A2-(b) / 出口补齐）：这里曾有一个 `renameOrg`，**全仓无调用**，
 * 也没有任何路由能改名组织。按"能力已实现但没出口"的处置原则删除 ——
 * 改名组织若要做，应该是**一条带权限与审计的路由**（`org:write`），
 * 而不是留一个可以从任何地方调、却不留痕的裸仓储函数。
 */

// ── 部门 ──────────────────────────────────────────────────────────────

export function createDepartment({ orgId, name, parentId = null }) {
  const id = newId('dep');
  run(
    'INSERT INTO departments (id, org_id, name, parent_id, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, orgId, String(name), parentId, nowIso()]
  );
  return getDepartment(orgId, id);
}

/** 所有部门查询都带 org_id —— 跨租户取不到 */
export function getDepartment(orgId, id) {
  return get('SELECT * FROM departments WHERE org_id = ? AND id = ?', [orgId, id]);
}

export function listDepartments(orgId) {
  return all('SELECT * FROM departments WHERE org_id = ? ORDER BY created_at ASC', [orgId]);
}

export function countDepartments(orgId) {
  const r = get('SELECT COUNT(*) AS n FROM departments WHERE org_id = ?', [orgId]);
  return r ? Number(r.n) : 0;
}

/** 部门名唯一性（同级内）—— 轻量校验，不做强制约束（schema 未设唯一键） */
export function findDepartmentByName(orgId, name) {
  return get('SELECT * FROM departments WHERE org_id = ? AND name = ?', [orgId, String(name)]);
}

/**
 * 改名 / 删除都**强制带 org_id**（同所有部门查询）—— 跨租户改不动、删不掉。
 *
 * 这两个函数与上面被删掉的 `renameOrg` 是不同性质：它们的调用点只有一个，
 * 是**带权限校验与审计留痕的路由**（PATCH/DELETE /api/identity/departments/:id）。
 * "能力已实现但没出口"的处置原则针对的是**无人调用的裸函数**；
 * 这里的出口已经先建好了。
 */
export function renameDepartment(orgId, id, name) {
  run('UPDATE departments SET name = ? WHERE org_id = ? AND id = ?', [String(name), orgId, id]);
  return getDepartment(orgId, id);
}

export function deleteDepartment(orgId, id) {
  run('DELETE FROM departments WHERE org_id = ? AND id = ?', [orgId, id]);
}

/**
 * 每个部门的**子部门数**（`Map<deptId, n>`）—— 理由与 users.mjs 的 countUsersByDept 相同：
 * 一次查询拿全，避免"列出 N 个部门打 N 次库"；`parent_id IS NULL` 不是"谁的子部门"，
 * 在 SQL 里排除而不是让调用方记得过滤。
 */
export function countDepartmentsByParent(orgId) {
  const rows = all(
    'SELECT parent_id, COUNT(*) AS n FROM departments WHERE org_id = ? AND parent_id IS NOT NULL GROUP BY parent_id',
    [orgId]
  );
  const m = new Map();
  for (const r of rows) m.set(r.parent_id, Number(r.n) || 0);
  return m;
}
