/**
 * 会话仓储。
 *
 * 纪律：**所有查询强制带 tenant_id 过滤**（仓储层统一注入，调用方无法绕过）。
 * 这是逻辑多租户隔离的第一道也是最关键的一道闸门。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { run, all, get } from '../db.mjs';
import { newId, nowIso } from '../../util/ids.mjs';

export function createSessionRow({
  tenantId, ownerUserId = null, kernelSessionId, title = '', cwd = '',
  presetId = null, kbIds = [], workspaceId = null, reasoningEffort = null,
}) {
  const id = newId('ses');
  const at = nowIso();
  run(
    `INSERT INTO agent_sessions
       (id, tenant_id, owner_user_id, kernel_session_id, title, cwd, preset_id, kb_ids,
        workspace_id, reasoning_effort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, tenantId, ownerUserId, kernelSessionId, title, cwd, presetId, encodeKbIds(kbIds),
      workspaceId, reasoningEffort, at, at]
  );
  return getSession(tenantId, id);
}

/** 会话挂载的知识库 id 列表。⚠️ 解析失败一律回 `[]`（=不挂库），不抛 —— 见 encodeKbIds。 */
export function decodeKbIds(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (!raw) return [];
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch { return []; }
}

/**
 * 序列化挂库清单。
 *
 * 三件事，都是刻意的：
 *   · **去重**：同一个库挂两次没有意义，且会让检索把它的权重变相放大；
 *   · **保序**：顺序即用户在界面上的勾选顺序，注入参考资料时按它排列 —— 让"先看哪个库"
 *     这件事对用户可控；
 *   · **上限**：与检索侧 SQL 变量数上限（`prefilter.maxCandidates` 同源约束）无关，
 *     纯粹是防"有人塞 500 个库进来把每轮检索打满"。超出部分直接截断而不报错 ——
 *     挂库是**增益**而不是**契约**，多勾了几个不该让对话发不出去。
 */
export const KB_PER_SESSION_MAX = 8;

export function encodeKbIds(list) {
  const arr = (Array.isArray(list) ? list : [])
    .map((x) => String(x == null ? '' : x).trim())
    .filter(Boolean);
  return JSON.stringify([...new Set(arr)].slice(0, KB_PER_SESSION_MAX));
}

export function getSession(tenantId, id) {
  return get('SELECT * FROM agent_sessions WHERE tenant_id = ? AND id = ?', [tenantId, id]);
}

export function listSessions(tenantId, { limit = 50, includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT * FROM agent_sessions WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?'
    : 'SELECT * FROM agent_sessions WHERE tenant_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?';
  return all(sql, [tenantId, Number(limit) || 50]);
}

export function touchSession(tenantId, id, patch = {}) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    // `kernel_session_id` 在列（0.21.6）：会话的**平台侧身份**可以早于上游会话存在。
    // （这条口径仍然成立 —— 见 kernel.mjs 的 requireSession。0.21.9 删掉「落脚会话」
    //   之后，正常路径上不再有这种行，但补建分支留着：它对任何"本地行早于上游"的
    //   会话都对，且删掉它就意味着"能打开却发不出消息"可能重新出现。）
    // 允许它变更不会造成"中途换上游会话"：写入点只有
    // 那一个补建分支，而它只在原本为空时才跑。
    if (['kernel_session_id', 'title', 'cwd', 'preset_id', 'model_provider', 'model_id', 'kb_ids',
      'archived_at', 'workspace_id', 'reasoning_effort'].includes(k)) {
      fields.push(k + ' = ?');
      params.push(v);
    }
  }
  fields.push('updated_at = ?');
  params.push(nowIso(), tenantId, id);
  run('UPDATE agent_sessions SET ' + fields.join(', ') + ' WHERE tenant_id = ? AND id = ?', params);
  return getSession(tenantId, id);
}

export function countSessions(tenantId) {
  const r = get('SELECT COUNT(*) AS n FROM agent_sessions WHERE tenant_id = ?', [tenantId]);
  return r ? Number(r.n) : 0;
}

/**
 * 删除会话行本体（0.16.0）。
 *
 * ⚠️ 只删行本体，不负责级联 —— 事件 / 附件 / 产物的删除在调用方（kernel 路由）
 * 的同一个事务里完成，因为附件字节清理是运行时动作（要拿 STORAGE_DIR），
 * 数据层不该知道它。外键开着（PRAGMA foreign_keys = ON），所以事件与附件行
 * 必须先于本行删除，否则整个事务会因约束失败回滚。
 * @returns {boolean} 是否真的删了
 */
export function deleteSessionRow(tenantId, id) {
  const r = run('DELETE FROM agent_sessions WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  return r.changes > 0;
}
