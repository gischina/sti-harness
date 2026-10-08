/**
 * 审计日志 —— **哈希链**，防篡改。
 *
 * 链式结构：
 *
 *     hash_n = SHA256( prev_hash ‖ tenant_id ‖ user_id ‖ action ‖ resource_type ‖ resource_id ‖ result ‖ detail ‖ at )
 *     prev_hash = 同租户上一条的 hash（首条为 ''）
 *
 * 为什么值得这么做：审计日志的价值全在「事后可信」。如果它只是一个普通表，
 * 有库权限的人删掉一行、改一个字段，事后完全看不出来。有了链，
 * 任何改动都会让**从该点起的所有** hash 对不上，`verifyChain()` 能定位到首个断裂点。
 *
 * ⚠️ 边界（不夸大）：这防的是"事后改数据"，不防"有写权限的人整表重写链"。
 * 真正的防篡改需要把链尾 hash **定期外发**到本平台控制不到的地方（只读介质/外部接收方）。
 *
 * → **P1-2 补上了这条腿**（此前 M5 承诺过但没做，是一个明确的未做项）：
 *   · `archive()` 把超期记录写成可独立复算的 JSONL 副本后从主表删除，
 *     并维护 `audit_chain_state.base_hash`（否则归档会打破可校验性）；
 *   · `anchor()` 每日把「链尾 hash + 记录数 + 链基准」落到 `data/anchor/` 与
 *     `audit_anchors` 表，可由定时任务 `audit.anchor` 顺带**出站**到外部。
 *   · 但请注意：**锚点与链在同一台机器上等于没锚**。平台把两件事都做了
 *     （落盘 + 可选出站），但不会因为你启用了锚点就说"现在防得住整表重写了"——
 *     那句话只在锚点真的离开这台机器之后才成立。
 *
 * M1 只用到 `append()`（越权与敏感操作留痕）；查询/校验接口在 M3 补。
 * P1-2 补 `archive()` / `anchor()` / `chainInfo()` / `listAnchors()`。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run, get, all, tx } from '../../data/db.mjs';
import { newId, nowIso } from '../../util/ids.mjs';
import { parseJsonSafe } from '../../util/json.mjs';

/** 未登录请求的归属租户。审计必须能记下"匿名访问被拒"，因此需要一个明确的占位值。 */
export const ANONYMOUS_TENANT = 'anonymous';

/** 默认保留期（天）。超过的进入归档；由定时任务 `audit.archive` 使用。 */
export const DEFAULT_RETENTION_DAYS = 90;

const CHAIN_FIELDS = ['tenant_id', 'user_id', 'action', 'resource_type', 'resource_id', 'result', 'detail_json', 'at'];

/** 计算一条审计记录的 hash（导出以便 verifyChain 复用同一算法，避免两处实现漂移） */
export function computeHash(prevHash, row) {
  const parts = [String(prevHash || '')];
  for (const f of CHAIN_FIELDS) parts.push(String(row[f] == null ? '' : row[f]));
  return crypto.createHash('sha256').update(parts.join('\u0001')).digest('hex');
}

/**
 * 链基准 —— 已被归档的那一段的链尾 hash。
 *
 * ⚠️ 没有它，归档就会**打破可校验性**：删除最旧若干行后，剩余第一条的
 * `prev_hash` 仍指向已删除的行，`verifyChain` 会在第 0 行报断裂。
 * 详见 migration 0009 里 `audit_chain_state` 的说明。
 */
function baseHashOf(tenantId) {
  const r = get('SELECT base_hash FROM audit_chain_state WHERE tenant_id = ?', [String(tenantId)]);
  return r && r.base_hash ? r.base_hash : '';
}

function prevHashOf(tenantId) {
  const r = get('SELECT hash FROM audit_logs WHERE tenant_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', [tenantId]);
  // 主表为空时（全新租户，或全部记录都已归档）起点是基准 hash，而不是空串。
  return r ? r.hash : baseHashOf(tenantId);
}

/**
 * 追加一条审计记录。
 *
 * `result` 取值：`ok`（成功）/ `denied`（越权或被治理拦截）/ `error`（执行出错）
 *
 * 本函数**不抛错**（除非数据库本身不可用）：审计写失败不该把业务请求一起打挂。
 * 但失败会返回 `{ok:false}` 并打印告警 —— 静默丢失审计比丢一个请求严重得多。
 */
export function append({
  tenantId = ANONYMOUS_TENANT,
  userId = null,
  action,
  resourceType = '',
  resourceId = '',
  result = 'ok',
  detail = null,
  at = nowIso(),
} = {}) {
  if (!action) return { ok: false, error: '缺少 action' };
  const tenant = String(tenantId || ANONYMOUS_TENANT);
  try {
    const row = {
      tenant_id: tenant,
      user_id: userId == null ? '' : String(userId),
      action: String(action),
      resource_type: String(resourceType || ''),
      resource_id: String(resourceId || ''),
      result: String(result),
      detail_json: detail == null ? '{}' : JSON.stringify(detail),
      at,
    };
    const prev = prevHashOf(tenant);
    const hash = computeHash(prev, row);
    const id = newId('aud');
    run(
      `INSERT INTO audit_logs
         (id, tenant_id, user_id, action, resource_type, resource_id, result, detail_json, prev_hash, hash, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, row.tenant_id, row.user_id, row.action, row.resource_type, row.resource_id,
        row.result, row.detail_json, prev, hash, row.at]
    );
    return { ok: true, id, hash, prevHash: prev };
  } catch (e) {
    // 审计写失败是严重问题（会形成"无记录的空窗"），必须吵出来，但不能打挂业务
    console.error('[audit] 写入失败（审计链可能出现空窗）：' + (e && e.message));
    return { ok: false, error: e && e.message };
  }
}

/** 某个租户的审计列表（M3 会加过滤与分页；现在够自检与排障用） */
export function list(tenantId, { limit = 100 } = {}) {
  return all(
    'SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY at DESC, rowid DESC LIMIT ?',
    [String(tenantId), Number(limit) || 100]
  );
}

/**
 * 带过滤与分页的审计查询（治理页用）。
 * 过滤条件只接受白名单字段；action 支持**前缀匹配**（如 `governance.` 查全部治理动作）。
 * @returns {{items:Array, total:number, latestHash:string|null}}
 */
export function query(tenantId, { action = null, result = null, userId = null, from = null, to = null, limit = 100, offset = 0 } = {}) {
  const where = ['tenant_id = ?'];
  const params = [String(tenantId)];
  if (action) { where.push('action LIKE ?'); params.push(String(action).replace(/[%_]/g, '') + '%'); }
  if (result) { where.push('result = ?'); params.push(String(result)); }
  if (userId) { where.push('user_id = ?'); params.push(String(userId)); }
  if (from) { where.push('at >= ?'); params.push(String(from)); }
  if (to) { where.push('at <= ?'); params.push(String(to)); }
  const W = where.join(' AND ');

  // tenant-ok: W 的第一项恒为 'tenant_id = ?'（见 query() 开头的 where 数组），不允许被绕过
  const totalRow = get(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${W}`, params);
  const items = all(
    // tenant-ok: 同上，W 恒含 tenant_id
    `SELECT * FROM audit_logs WHERE ${W} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`,
    [...params, Math.min(Number(limit) || 100, 500), Math.max(Number(offset) || 0, 0)]
  );
  const tail = get(
    'SELECT hash FROM audit_logs WHERE tenant_id = ? ORDER BY at DESC, rowid DESC LIMIT 1',
    [String(tenantId)]
  );
  return { items, total: totalRow ? Number(totalRow.n) : 0, latestHash: tail ? tail.hash : null };
}

export function count(tenantId) {
  const r = get('SELECT COUNT(*) AS n FROM audit_logs WHERE tenant_id = ?', [String(tenantId)]);
  return r ? Number(r.n) : 0;
}

/**
 * 重算哈希链，定位首个断裂点。
 *
 * ⚠️ 起点是**链基准**（base_hash）而不是空串 —— 归档过的租户，其剩余链的
 * 第一条记录的 prev_hash 指向"已被归档段的链尾"。用空串起算会立刻误报断裂。
 * 返回值里带上 `base`，让"校验通过"这件事能被外部核对（说明是**从哪起**算通过的）。
 *
 * @returns {{ok:boolean, checked:number, base:string, brokenAt?:object}}
 */
export function verifyChain(tenantId) {
  const rows = all(
    'SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY at ASC, rowid ASC',
    [String(tenantId)]
  );
  const base = baseHashOf(tenantId);
  let prev = base;
  for (let i = 0; i < rows.length; i++) {
    const expect = computeHash(prev, rows[i]);
    if (rows[i].prev_hash !== prev || rows[i].hash !== expect) {
      return {
        ok: false,
        checked: i,
        total: rows.length,
        base,
        brokenAt: {
          index: i, id: rows[i].id, at: rows[i].at, action: rows[i].action,
          expectedPrev: prev, actualPrev: rows[i].prev_hash,
          expectedHash: expect, actualHash: rows[i].hash,
        },
      };
    }
    prev = rows[i].hash;
  }
  return { ok: true, checked: rows.length, total: rows.length, base };
}

/* ── 保留、归档与链尾锚定（P1-2）───────────────────────────────────── */

/** 链状态：基准、已归档数量、主表保留数量。管理页与锚点都要它。 */
export function chainInfo(tenantId) {
  const tid = String(tenantId);
  const s = get('SELECT * FROM audit_chain_state WHERE tenant_id = ?', [tid]);
  const retained = get('SELECT COUNT(*) AS n FROM audit_logs WHERE tenant_id = ?', [tid]);
  return {
    baseHash: s && s.base_hash ? s.base_hash : '',
    archivedCount: s ? Number(s.archived_count || 0) : 0,
    archivedAt: s ? (s.archived_at || null) : null,
    retained: retained ? Number(retained.n) : 0,
  };
}

/**
 * 归档：把超过保留期的审计写成 **JSONL 只读副本**，然后从主表删除。
 *
 * 三条纪律：
 *   1. **先落盘、后删除**。写文件失败就一条都不删 —— "删了但没存下"是数据丢失，
 *      不可逆。
 *   2. **删除动作本身入链**（在删除之后追加一条 `audit.archive` 记录）。
 *      不然"审计少了 5000 条"这件事在链上完全没有痕迹，这正是审计要防的。
 *   3. **更新链基准**。被删掉那一段的链尾 hash 成为剩余链的起点 ——
 *      没有这一步，`verifyChain` 会立刻报断裂（见 0009 迁移说明）。
 *
 * 文件按 `audit-<tenant>-YYYYMM.jsonl` 分月追加，一行一条原始记录（含 hash），
 * 使外部工具可以独立复算链 —— 归档副本不是"给人看的日志"，是**可校验的证物**。
 *
 * @returns {{archived:number, cutoff:string, file:string|null, files:string[]}}
 */
export function archive({ tenantId, retentionDays = DEFAULT_RETENTION_DAYS, dir } = {}) {
  const tid = String(tenantId);
  const days = Number(retentionDays) > 0 ? Number(retentionDays) : DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  if (!dir) return { archived: 0, cutoff, file: null, files: [], error: '未提供归档目录（装配缺陷）' };

  const rows = all(
    'SELECT * FROM audit_logs WHERE tenant_id = ? AND at < ? ORDER BY at ASC, rowid ASC',
    [tid, cutoff]
  );
  if (!rows.length) return { archived: 0, cutoff, file: null, files: [] };

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { archived: 0, cutoff, file: null, files: [], error: '创建归档目录失败：' + (e && e.message) };
  }

  // 按月分组写文件（同月追加，不同月各一份）
  const byMonth = new Map();
  for (const r of rows) {
    const m = String(r.at || '').slice(0, 7).replace('-', '') || 'unknown';
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  const files = [];
  try {
    for (const [month, list] of byMonth) {
      const file = path.join(dir, 'audit-' + tid + '-' + month + '.jsonl');
      const payload = list.map((r) => JSON.stringify({
        id: r.id, tenantId: r.tenant_id, userId: r.user_id, action: r.action,
        resourceType: r.resource_type, resourceId: r.resource_id, result: r.result,
        detail: parseJsonSafe(r.detail_json), prevHash: r.prev_hash, hash: r.hash, at: r.at,
      })).join('\n') + '\n';
      fs.appendFileSync(file, payload, 'utf8');
      files.push(file);
    }
  } catch (e) {
    // 落盘失败 → 一条都不删（宁可库里长着，也不能"删了但没存下"）
    return { archived: 0, cutoff, file: null, files, error: '写归档文件失败（未删除任何记录）：' + (e && e.message) };
  }

  const lastHash = rows[rows.length - 1].hash;
  const ids = rows.map((r) => r.id);
  // 删除与基准更新必须在一个事务里：否则中途失败会留下"记录删了但基准没动"
  // 的状态 —— 那会让剩余链立刻校验不过，且没有任何迹象说明原因。
  try {
    // 删除 + 更新基准必须在同一事务里：中途失败会留下"记录删了但基准没动"的状态，
    // 那会让剩余链立刻校验不过，且没有任何迹象说明原因。
    tx(() => {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        run('DELETE FROM audit_logs WHERE tenant_id = ? AND id IN (' + chunk.map(() => '?').join(',') + ')',
          [tid, ...chunk]);
      }
      const now = nowIso();
      const prevState = get('SELECT archived_count FROM audit_chain_state WHERE tenant_id = ?', [tid]);
      run(
        `INSERT INTO audit_chain_state (tenant_id, base_hash, archived_count, archived_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET
           base_hash = excluded.base_hash,
           archived_count = excluded.archived_count,
           archived_at = excluded.archived_at,
           updated_at = excluded.updated_at`,
        [tid, lastHash, Number((prevState && prevState.archived_count) || 0) + ids.length, now, now]
      );
    });
  } catch (e) {
    return { archived: 0, cutoff, file: files[0] || null, files, error: '删除/更新基准失败（已回滚）：' + (e && e.message) };
  }

  // 归档动作入链 —— 在删除之后追加，因此它会链在新的链尾上（一致）
  append({
    tenantId: tid, userId: null,
    action: 'audit.archive', resourceType: 'audit', resourceId: tid,
    result: 'ok',
    detail: { archived: ids.length, retentionDays: days, cutoff, files: files.map((f) => path.basename(f)), newBaseHash: lastHash },
  });

  return { archived: ids.length, cutoff, file: files[0] || null, files };
}

/**
 * 链尾锚定：把「当日最后一条 hash + 记录数 + 链基准」固定到两处 ——
 * `data/anchor/` 下的只读 JSON 与 `audit_anchors` 表。
 *
 * ⚠️ 锚点只有在**离开这台机器**时才有意义。表里那一行只是便于页面展示与人工核对，
 *    它防不了"有库权限的人连锚点表一起改"。真正的防篡改需要
 *    ① 锚点文件落在只读挂载/异地介质，或 ② 通过 notify 出站把它发到外部。
 *    调度任务 `audit.anchor` 会尝试出站（见 tasks.mjs），并在结果里如实回报
 *    有没有发出去 —— 没发出去就**不假装已经防住了**。
 *
 * 同时报出 baseHash：外部核对者需要知道"这段链是从哪个 hash 起算的"，
 * 否则无法判断链是否被截断过（只给链尾等于只给了一半信息）。
 *
 * @returns {{ok:boolean, day:string, tailHash:string, recordCount:number, baseHash:string, file:string|null, error?:string}}
 */
export function anchor({ tenantId, dir } = {}) {
  const tid = String(tenantId);
  const day = new Date().toISOString().slice(0, 10);
  const last = get('SELECT hash FROM audit_logs WHERE tenant_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', [tid]);
  const info = chainInfo(tid);
  const tailHash = last ? last.hash : info.baseHash;
  const recordCount = info.retained;
  const anchoredAt = nowIso();
  const payload = {
    tenantId: tid, day, tailHash, recordCount, baseHash: info.baseHash,
    archivedCount: info.archivedCount, anchoredAt,
    note: 'tailHash 是「主表最后一条」的 hash；baseHash 是已归档段的链尾（链的起点）。'
      + '二者一起才能判断链有没有被截断。',
  };

  let file = null;
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, 'audit-anchor-' + tid + '-' + day + '.json');
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      return { ok: false, day, tailHash, recordCount, baseHash: info.baseHash, file: null, error: '写锚点文件失败：' + (e && e.message) };
    }
  }

  run(
    `INSERT INTO audit_anchors (id, tenant_id, day, tail_hash, record_count, file_path, anchored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, day) DO UPDATE SET
       tail_hash = excluded.tail_hash, record_count = excluded.record_count,
       file_path = excluded.file_path, anchored_at = excluded.anchored_at`,
    [newId('anr'), tid, day, tailHash, recordCount, file || '', anchoredAt]
  );

  return { ok: true, day, tailHash, recordCount, baseHash: info.baseHash, file };
}

/** 锚点历史（管理页用） */
export function listAnchors(tenantId, { limit = 90 } = {}) {
  return all(
    'SELECT * FROM audit_anchors WHERE tenant_id = ? ORDER BY day DESC LIMIT ?',
    [String(tenantId), Math.min(Number(limit) || 90, 365)]
  ).map((r) => ({
    day: r.day,
    tailHash: r.tail_hash,
    recordCount: Number(r.record_count),
    filePath: r.file_path || null,
    anchoredAt: r.anchored_at,
  }));
}
