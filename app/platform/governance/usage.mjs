/**
 * 用量采集 —— 从**契约层事件**取真实 token 数，绝不估算。
 *
 * 数据源与语义（这是验收标准 4 的核心）：
 *   · 每一轮对话的事件流里会出现 `usage` 类型事件（contract.mjs 的 USAGE_FIELDS：
 *     input / cacheRead / cacheWrite / output / reasoning）；
 *   · `input` 的语义是「**未缓存输入**」，不是「总输入」—— 计费输入 = input + cacheRead + cacheWrite，
 *     reasoning 是 output 的子集，不另计（详见 contract.mjs 顶部注释）；
 *   · 采集时**逐字段照抄**事件里的数字：事件里没有的字段写 0、整条没有 usage 事件就不写行。
 *     **任何"估算/补齐/平均"都会让账本与上游事件对不上** —— 验收要求逐字段可比对。
 *
 * ⚠️ 诚实边界：ttft_ms / tps 目前上游事件里没有（usage 事件只有 5 个 token 字段），
 * 表里这两列保留但恒为 NULL —— 不假装测过。接入真实上游后由契约层事件补齐。
 *
 * ⚠️ 归因边界（P1-3 / 成本核算）：`model_id` 写的是**平台要求上游使用的模型**
 * （来自 `agent_sessions.model_id`，即会话上显式选择过的模型），**不是从上游事件里
 * 观测到的**——上游的 usage 事件不带模型名。没选过模型的会话就写空串，
 * 这些用量会在成本报告里进 `unattributed` 桶。这是如实的：拿默认模型的单价去套
 * 会给出一个确定但错误的数，比"归因不到"更糟。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { run, get, all } from '../../data/db.mjs';
import { newId, nowIso } from '../../util/ids.mjs';
import { pickUsageEntries } from '../../util/usage-pick.mjs';
import * as concurrency from './concurrency.mjs';

const TOKEN_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从一轮对话的事件里采集 usage（每条带用量的记录一行）。
 *
 * ── 为什么不能只看 `type === 'usage'`（真机验收抓到的漏账）────────────────
 *   上游**没有独立的 usage 事件**：用量挂在 `assistant/message` 的 `data.usage` 上
 *   （契约层 events.mjs 顶部早已写明这一点）。此前这里只认 `type === 'usage'`，
 *   于是**真内核上每一轮的用量都记 0 行** —— 而工作台仍然显示"用量事件 0 / 累计 tokens 0"，
 *   那不是"没数据"，是一句**与事实相反的话**：模型确实消耗了 562 输入 + 6656 缓存 + 2 输出，
 *   账上却是 0。零依赖的 fixtures / 测试替身恰好会发独立的 usage 事件，
 *   所以这个缺陷在回归里一直是绿的（**桩数据形状与真实形状漂移**的又一例）。
 *   现在按"**任何带 usage 对象的记录都算**"采集。
 *
 * ── 为什么"有独立 usage 事件时就不看别的"──────────────────────────────
 *   同一轮里，助手消息与独立的 usage 事件可能带的是**同一组数字**。
 *   两个都记就是**把一笔账记两遍**，比漏账更难发现（总数看着还挺合理）。
 *   取法有明确优先级：**有独立 usage 事件就只认它**；一条都没有时，才从挂载用量的
 *   记录里取。这样对两种上游形态都正确，且永远不会重复计数。
 *
 * @param {{tenantId:string, userId?:string|null, sessionId:string, turnId?:string|null,
 *          modelId?:string|null, events:Array<object>}} p
 *   `modelId` = 会话上登记的模型名（"平台要求上游用哪个"）。缺省写空串，
 *   成本报告据此归因；空串 → unattributed（见文件顶部归因边界）。
 * @returns {{written:number, skipped:number, totals:object}}
 */
export function recordFromEvents({ tenantId, userId = null, sessionId, turnId = null, modelId = null, events }) {
  if (!Array.isArray(events)) return { written: 0, skipped: 0, totals: emptyTotals() };
  const at = nowIso();
  const mid = modelId == null ? '' : String(modelId);
  let written = 0;
  const totals = emptyTotals();

  // 取数规则是**单一真源**（app/util/usage-pick.mjs）—— 工作台面板的汇总用的是同一个函数，
  // 两份各自为政的实现迟早会算出两个数。
  const picked = pickUsageEntries(events.map((ev) => ({
    turnId, type: ev && ev.type, usage: ev && ev.usage,
  })));

  // 坏数据（带了 usage 字段但不是对象）**如实计数但不写行** —— 缺就是缺，不补 0 也不猜。
  const skipped = events.filter((ev) => ev && ev.usage !== undefined
    && (!ev.usage || typeof ev.usage !== 'object')).length;

  for (const u of picked) {
    const row = {
      input: num(u.input),
      cacheRead: num(u.cacheRead),
      cacheWrite: num(u.cacheWrite),
      output: num(u.output),
      reasoning: num(u.reasoning),
    };
    run(
      `INSERT INTO usage_records
         (id, tenant_id, user_id, session_id, turn_id, input, cache_read, cache_write, output, reasoning, ttft_ms, tps, model_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [newId('usg'), String(tenantId), userId == null ? null : String(userId),
        String(sessionId), turnId == null ? null : String(turnId),
        row.input, row.cacheRead, row.cacheWrite, row.output, row.reasoning, mid, at]
    );
    written++;
    for (const k of TOKEN_FIELDS) totals[k] += row[k];
  }
  return { written, skipped, totals, modelId: mid };
}

function emptyTotals() {
  const t = {};
  for (const k of TOKEN_FIELDS) t[k] = 0;
  return t;
}

/**
 * 汇总查询（管理页用）。
 * @returns {{totals, byDay, byUser, bySession, rows}}
 */
export function summarize(tenantId, { from = null, to = null, userId = null, sessionId = null, limit = 200 } = {}) {
  const where = ['tenant_id = ?'];
  const params = [String(tenantId)];
  if (from) { where.push('created_at >= ?'); params.push(String(from)); }
  if (to) { where.push('created_at <= ?'); params.push(String(to)); }
  if (userId) { where.push('user_id = ?'); params.push(String(userId)); }
  if (sessionId) { where.push('session_id = ?'); params.push(String(sessionId)); }
  const W = where.join(' AND ');

  // tenant-ok: W 恒以 tenant_id = ? 开头（见 summarize() 开头的 where 数组）
  const rows = all(`SELECT * FROM usage_records WHERE ${W} /* tenant-ok: W 恒含 tenant_id（summarize） */ ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [...params, Number(limit) || 200]);

  const totals = emptyTotals();
  let billableInput = 0;
  for (const r of rows) {
    for (const k of TOKEN_FIELDS) totals[k] += num(r[k === 'cacheRead' ? 'cache_read' : k === 'cacheWrite' ? 'cache_write' : k]);
    billableInput += num(r.input) + num(r.cache_read) + num(r.cache_write);
  }

  const byDay = all(
    `SELECT substr(created_at, 1, 10) AS day,
            SUM(input) AS input, SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite,
            SUM(output) AS output, SUM(reasoning) AS reasoning, COUNT(*) AS turns
       FROM usage_records WHERE ${W} /* tenant-ok: W 恒含 tenant_id */ GROUP BY day ORDER BY day DESC LIMIT 60`, params);

  // 用户列要带出**用户名**（LEFT JOIN users）：治理面板是给人看的对账单，
  // 一列裸 ID（usr_0mur…）逼着管理员去账号管理页逐个对号，这不是显示细节，
  // 是成本归因可读性的必要部分。用户被删后 JOIN 不上 → 如实标"(已删除用户)"。
  // W 在子查询里原样生效（它含裸列名），外层再用 ur. 前缀，避免给 W 做列名改写。
  const byUser = all(
    `SELECT COALESCE(ur.user_id, '(未登录)') AS userId,
            COALESCE(u.username, '(已删除用户)') AS username,
            COALESCE(u.display_name, '') AS displayName,
            SUM(ur.input) AS input, SUM(ur.cache_read) AS cacheRead, SUM(ur.cache_write) AS cacheWrite,
            SUM(ur.output) AS output, SUM(ur.reasoning) AS reasoning, COUNT(*) AS turns
       FROM (SELECT * FROM usage_records WHERE ${W} /* tenant-ok: W 恒含 tenant_id */) ur
       LEFT JOIN users u ON u.id = ur.user_id
      GROUP BY ur.user_id ORDER BY output DESC LIMIT 50`, params);

  const bySession = all(
    `SELECT session_id AS sessionId,
            SUM(input) AS input, SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite,
            SUM(output) AS output, SUM(reasoning) AS reasoning, COUNT(*) AS turns
       FROM usage_records WHERE ${W} /* tenant-ok: W 恒含 tenant_id（summarize） */ GROUP BY session_id ORDER BY output DESC LIMIT 50`, params);

  return {
    totals: { ...totals, billableInput, usageRows: rows.length },
    byDay, byUser, bySession,
    sampled: rows.length < limit ? rows.length : limit,
  };
}

/**
 * 配额检查用的「已用量」。
 *
 * turns 的口径：**events 表里 turn-start 事件数**（按 tenant 过滤经 agent_sessions join）。
 * 不用 usage_records 的 DISTINCT turn_id —— 那样"没有 usage 事件的回合"会被漏计，
 * 账就少了。宁可查询贵一点也要账对得上。
 *
 * token 的口径：usage_records 求和（它就是真实事件的照抄）。
 */
export function consumed(tenantId, { userId = null, metric, period }) {
  const since = periodStart(period);
  if (metric === 'turns') {
    const cond = ['s.tenant_id = ?', "e.type = 'turn-start'"];
    const params = [String(tenantId)];
    if (since) { cond.push('e.created_at >= ?'); params.push(since); }
    if (userId) { cond.push('s.owner_user_id = ?'); params.push(String(userId)); }
    const r = get(
      // tenant-ok: cond 恒以 's.tenant_id = ?' 开头（见上方 cond 数组的第一项），
      // 且该字面量在源码里离本字符串较远，静态扫描的 800 字符窗口抓不到 ——
      // 因此显式标注，而不是把它挪近以"哄过"扫描（那会让代码为了工具而变形）。
      `SELECT COUNT(*) AS n FROM events e JOIN agent_sessions s ON s.id = e.session_id WHERE ${cond.join(' AND ')}`,
      params);
    return { metric, period, since, used: r ? Number(r.n) : 0 };
  }
  if (metric === 'concurrent') {
    // P1-2 起**真有计量**：在途回合数（内存计数，见 concurrency.mjs）。
    // 用户级配额取该用户在途数；租户级取该租户下所有用户之和。
    // period 对并发没有意义（它是个瞬时量，不是累计量）—— 如实返回 null。
    const used = userId ? concurrency.activeForUser(tenantId, userId) : concurrency.activeForTenant(tenantId);
    return { metric, period, since: null, used, instantaneous: true };
  }
  // token 类：input_tokens / output_tokens
  const col = metric === 'input_tokens'
    ? 'input + cache_read + cache_write'     // 计费输入 = 三段之和（与 contract.mjs 语义一致）
    : metric === 'output_tokens' ? 'output' : null;
  if (!col) return { metric, period, since, used: 0, unknownMetric: true };
  const cond = ['tenant_id = ?'];
  const params = [String(tenantId)];
  if (since) { cond.push('created_at >= ?'); params.push(since); }
  if (userId) { cond.push('user_id = ?'); params.push(String(userId)); }
  const r = get(`SELECT COALESCE(SUM(${col}), 0) AS n FROM usage_records WHERE ${cond.join(' AND ')} /* tenant-ok: cond 恒以 tenant_id = ? 开头（consumed） */`, params);
  return { metric, period, since, used: r ? Number(r.n) : 0 };
}

/** 周期起点（ISO 字符串或 null）。day=今天零点、month=本月 1 号零点、total/null=不限。 */
export function periodStart(period) {
  // ⚠️ 必须用 UTC 边界：nowIso() 存的是 toISOString()（UTC），字符串比较才成立。
  //    用本地时间算边界会在非 UTC 时区把"今天"错切 8 小时（UTC+8 下账会少算）。
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === 'day') return new Date(Date.UTC(y, m, d)).toISOString();
  if (period === 'month') return new Date(Date.UTC(y, m, 1)).toISOString();
  return null;   // total / 未知 → 不限时间
}
