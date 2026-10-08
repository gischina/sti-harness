/**
 * 事件仓储。
 *
 * ⚠️ 这里是全库**唯一的写热点**（一轮对话几十~上百条事件），
 * 所以写入一律走 `appendEvents` 的**批量单事务**，不提供逐条写入接口 ——
 * 从接口形状上就杜绝"逐条 INSERT 把 SQLite 单写者拖死"这个坑。
 * 详见 docs/feasibility.md §1.2.2 与 architecture.md §7.4。
 *
 * 落库字段是**语义字段名**（input_tokens 等），不是上游原名。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { run, all, get, tx } from '../db.mjs';
import { newId, nowIso } from '../../util/ids.mjs';
import { pickUsageEntries } from '../../util/usage-pick.mjs';

/**
 * 批量追加事件（单事务）。
 * @param {string} sessionId 平台会话 id（不是上游会话 id）
 * @param {Array<object>} events normalizeEvent 产出的 KernelEvent 数组
 * @returns {{inserted:number, skipped:number, lastSeq:number}}
 */
export function appendEvents(sessionId, events) {
  if (!Array.isArray(events) || !events.length) return { inserted: 0, skipped: 0, lastSeq: currentSeq(sessionId) };
  const at = nowIso();
  const prepared = [];
  const seen = new Set();
  for (const ev of events) {
    const seq = Number(ev.seq);
    if (!Number.isFinite(seq)) continue;
    const key = seq;                       // 同一会话内 seq 唯一
    if (seen.has(key)) continue;
    seen.add(key);
    prepared.push({
      id: newId('ev'),
      sessionId,
      turnId: ev.turnId || null,
      seq,
      type: String(ev.type || 'unknown'),
      role: ev.role || null,
      payload: JSON.stringify({
        known: ev.known !== false,
        text: ev.text ?? null,
        delta: ev.delta ?? null,
        tool: ev.tool || null,
        usage: ev.usage || null,
        ruleId: ev._ruleId || null,
        upstreamType: ev._upstreamType || null,
      }),
    });
  }
  if (!prepared.length) return { inserted: 0, skipped: events.length, lastSeq: currentSeq(sessionId) };

  const existing = new Set(
    all('SELECT seq FROM events WHERE session_id = ?', [sessionId]).map((r) => Number(r.seq))
  );
  let inserted = 0;
  let skipped = 0;
  tx(() => {
    for (const p of prepared) {
      if (existing.has(p.seq)) { skipped++; continue; }
      run(
        'INSERT INTO events (id, session_id, turn_id, seq, type, role, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [p.id, p.sessionId, p.turnId, p.seq, p.type, p.role, p.payload, at]
      );
      inserted++;
    }
  });
  return { inserted, skipped, lastSeq: currentSeq(sessionId) };
}

export function currentSeq(sessionId) {
  const r = get('SELECT MAX(seq) AS m FROM events WHERE session_id = ?', [sessionId]);
  return r && r.m !== null && r.m !== undefined ? Number(r.m) : 0;
}

export function listEvents(sessionId, { fromSeq = 0, limit = 500 } = {}) {
  return all(
    'SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    [sessionId, Number(fromSeq) || 0, Number(limit) || 500]
  ).map(hydrate);
}

export function countEvents(sessionId) {
  const r = get('SELECT COUNT(*) AS n FROM events WHERE session_id = ?', [sessionId]);
  return r ? Number(r.n) : 0;
}

// ── 这里曾经有 `searchEvents(sessionId, { q, limit })`（会话内检索的仓储层）─────────────
// 与 `kernel.sessions.search` 路由一起，于本轮被**整块删除**（用户裁决："整块删除"）。
// 它当时做对的两件事，将来要加回来时别丢：
//   ① `LIKE` 的通配符必须转义（`needle.replace(/[\\%_]/g, c => '\\' + c)` + `ESCAPE '\\'`），
//      否则用户输入一个 `%` 就变成"匹配一切"；
//   ② `events` 表没有 tenant_id，调用方**必须先用** `sessions.getSession(tenantId, id)`
//      证明会话归属 —— 检索不是归属校验的例外通道（与 `listEvents` 同一条纪律）。

/** 把落库行还原成前端可直接用的形状（payload 摊平） */
export function hydrate(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch { /* 保底空对象 */ }
  return {
    seq: Number(row.seq),
    turnId: row.turn_id || null,
    type: row.type,
    role: row.role || null,
    known: payload.known !== false,
    text: payload.text ?? null,
    delta: payload.delta ?? null,
    tool: payload.tool || null,
    usage: payload.usage || null,
    at: row.created_at,
  };
}

/** 用量汇总（M3 的配额与用量页会用到；M0 先提供只读统计） */
/**
 * 会话用量汇总（工作台面板 / 会话详情读它）。
 *
 * ⚠️ 取数规则走**单一真源** `app/util/usage-pick.mjs` —— 与写 `usage_records` 的
 * `governance/usage.mjs` **必须是同一条规则**。
 *
 * 这里曾经自己写着 `WHERE type = 'usage'`，与那边各算各的；而真上游**没有独立的 usage 事件**
 * （用量挂在 `assistant/message` 上），于是真内核上每一轮都汇总成 0，
 * 工作台就不停地说"累计 tokens 0" —— 那不是"没数据"，是一句与事实相反的话。
 * 同一件事两份实现，改对了其中一份、另一份还会错很久：**所以只留一份**。
 */
export function usageSummary(sessionId) {
  const rows = all(
    "SELECT turn_id, type, payload_json FROM events WHERE session_id = ?",
    [sessionId]
  );
  const records = [];
  for (const r of rows) {
    let u = null;
    try { u = JSON.parse(r.payload_json || '{}').usage || null; } catch { u = null; }
    if (!u || typeof u !== 'object') continue;
    records.push({ turnId: r.turn_id, type: r.type, usage: u });
  }
  const picked = pickUsageEntries(records);
  const total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  for (const u of picked) {
    for (const k of Object.keys(total)) total[k] += Number(u[k] || 0);
  }
  return { ...total, usageEvents: picked.length };
}

/**
 * 删除某会话的全部事件（0.16.0 会话删除的级联面）。
 *
 * 「事件是 append-only 的轨迹」指的是**会话存活期间**：轨迹挂在会话上，
 * 会话没了轨迹就失去对象 —— 留着一堆孤儿事件只会污染全库统计。
 * 配额与成本依据是 usage_records（不随会话删除），不是这里的原始事件。
 * @returns {number} 实际删除的行数
 */
export function deleteForSession(sessionId) {
  const r = run('DELETE FROM events WHERE session_id = ?', [sessionId]);
  return r.changes || 0;
}
