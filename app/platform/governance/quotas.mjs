/**
 * 配额 —— 「先检后放行」，超限 block / warn 可配。
 *
 * 数据模型（quotas 表，0001 建表 + 0003 加 mode 列）：
 *   subject_type = tenant | user  ×  subject_id
 *   metric       = turns | input_tokens | output_tokens | concurrent
 *   period       = day | month | total
 *   mode         = block（超限拦截）| warn（超限提醒但放行）
 *
 * ⚠️ 语义边界（**不夸大，写在这里并且运行时也如实提示**）：
 *   · `turns` 是**真·事前闸**：提交回合前检查本周期已提交的回合数，超了就拦；
 *   · token 类是**软闸**：按「本周期已用量 ≥ 上限」拦截**下一次**提交 ——
 *     平台无法预知这一轮会花多少 token，精确的事前拦截需要 model gateway
 *     在模型侧计费后再放行（roadmap 定在 v1.0）。这是 v0.5 方案 A 的「事后统计 + 达标阻断」。
 *     绝不把它说成"精确的事前拦截"。
 *   · `concurrent` 自 **P1-2** 起**真有闸**：内存计数（concurrency.mjs）——
 *     这与本项目的部署形态（单进程）一致，因此不是"临时凑合"而是正确答案。
 *     企业最容易被"一个租户跑满并发把平台拖垮"打穿，这条闸就是补这个洞。
 *     M3 时它被如实标为未实装（`unknownMetric`），现在那个标记已经去掉了。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { run, get, all } from '../../data/db.mjs';
import { newId, nowIso } from '../../util/ids.mjs';
import * as usage from './usage.mjs';
import * as concurrency from './concurrency.mjs';

export const METRICS = ['turns', 'input_tokens', 'output_tokens', 'concurrent'];
export const PERIODS = ['day', 'month', 'total'];
export const MODES = ['block', 'warn'];

/** 某租户的配额清单（附当前已用量，管理页直接可用） */
export function list(tenantId) {
  const rows = all(
    'SELECT * FROM quotas WHERE tenant_id = ? ORDER BY subject_type, subject_id, metric, period',
    [String(tenantId)]
  );
  return rows.map((r) => {
    let used = null;
    let evaluated = false;
    try {
      const c = usage.consumed(String(tenantId), {
        userId: r.subject_type === 'user' ? r.subject_id : null,
        metric: r.metric,
        period: r.period,
      });
      used = c.used;
      // P1-2 起 concurrent **真有计量**（内存在途计数，见 concurrency.mjs）：
      // `consumed()` 对它返回 {used, instantaneous:true}，**不再**带 unknownMetric。
      // 这里的判据只该是"这个 metric 认不认识"，别再把 concurrent 当作例外 ——
      // 旧注释写的"concurrent 未实装计量"已是过期文案（代码上线、注释没跟上）。
      evaluated = !c.unknownMetric;
    } catch { used = null; evaluated = false; }
    return {
      id: r.id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      metric: r.metric,
      limitValue: r.limit_value,
      period: r.period,
      mode: r.mode || 'block',
      enabled: !!r.enabled,
      used,
      evaluated,
      // 并发是**瞬时量**：它没有"本周期累计"的概念，页面上要标清楚，
      // 否则"已用 0/5"会被读成"今天一个人都还没跑"。
      note: r.metric === 'concurrent' ? '并发是瞬时在途回合数（无周期累计语义）' : undefined,
      createdAt: r.created_at || undefined,
    };
  });
}

function validate({ subjectType, subjectId, metric, limitValue, period, mode }) {
  if (!['tenant', 'user'].includes(subjectType)) return 'subjectType 必须是 tenant 或 user';
  if (!subjectId) return '缺少 subjectId';
  if (!METRICS.includes(metric)) return 'metric 必须是 ' + METRICS.join(' / ');
  if (!(Number(limitValue) > 0)) return 'limitValue 必须大于 0';
  if (!PERIODS.includes(period)) return 'period 必须是 ' + PERIODS.join(' / ');
  if (mode != null && !MODES.includes(mode)) return 'mode 必须是 block 或 warn';
  return null;
}

/** 创建/更新一条配额（同 subject×metric×period 只有一条，重复则覆盖 limit/mode/enabled） */
export function upsert({ tenantId, subjectType, subjectId, metric, limitValue, period, mode = 'block', enabled = true }) {
  const err = validate({ subjectType, subjectId, metric, limitValue, period, mode });
  if (err) return { ok: false, error: err };
  try {
    run(
      `INSERT INTO quotas (id, tenant_id, subject_type, subject_id, metric, limit_value, period, enabled, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, subject_type, subject_id, metric, period)
       DO UPDATE SET limit_value = excluded.limit_value, mode = excluded.mode, enabled = excluded.enabled`,
      [newId('qta'), String(tenantId), subjectType, String(subjectId), metric,
        Number(limitValue), period, enabled ? 1 : 0, mode]
    );
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
  const row = get(
    'SELECT id FROM quotas WHERE tenant_id = ? AND subject_type = ? AND subject_id = ? AND metric = ? AND period = ?',
    [String(tenantId), subjectType, String(subjectId), metric, period]);
  return { ok: true, id: row && row.id };
}

export function remove(tenantId, id) {
  const r = run('DELETE FROM quotas WHERE tenant_id = ? AND id = ?', [String(tenantId), String(id)]);
  return { ok: true, deleted: r.changes || 0 };
}

/**
 * 按行 id 编辑配额（0.16.0）：只允许改 limitValue / mode / enabled 三个运行时字段。
 *
 * 为什么不提供改 subject/metric/period：那是这条规则的**身份**（业务键），
 * 改了等于"删一条旧的、建一条新的" —— 换个对象应该走删除+新建（审计上
 * 也才能看清"给谁加了什么"）。行内可改的只有"这条规则有多严、严到什么程度、
 * 开没开"这三件事。
 *
 * 校验走与 upsert 同一套 validate（用现值+补丁拼完整输入），不会出现
 * "只改 mode 却把 limit 顺手绕过校验"的口子。
 */
export function update(tenantId, id, patch = {}) {
  const row = get('SELECT * FROM quotas WHERE tenant_id = ? AND id = ?', [String(tenantId), String(id)]);
  if (!row) return { ok: false, notFound: true, error: '配额规则不存在：' + id };

  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  const merged = {
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    metric: row.metric,
    period: row.period,
    limitValue: has('limitValue') ? patch.limitValue : row.limit_value,
    mode: has('mode') ? patch.mode : (row.mode || 'block'),
  };
  const err = validate(merged);
  if (err) return { ok: false, error: err };
  if (has('enabled') && typeof patch.enabled !== 'boolean') {
    return { ok: false, error: 'enabled 必须是布尔值（true / false）' };
  }

  run(
    'UPDATE quotas SET limit_value = ?, mode = ?, enabled = ? WHERE tenant_id = ? AND id = ?',
    [
      Number(merged.limitValue), merged.mode,
      has('enabled') ? (patch.enabled ? 1 : 0) : (row.enabled ? 1 : 0),
      String(tenantId), String(id),
    ]
  );
  return { ok: true, id: String(id) };
}

/**
 * 配额判定（quota 中间件与回合提交前的唯一入口）。
 *
 * @param {{tenantId:string, userId?:string|null, metric:string}} p
 * @returns {{
 *   action:'pass'|'block'|'warn', checked:Array<object>, reason?:string
 * }} action 取最严的判定：任一 block → block；否则任一 warn → warn。
 */
export function evaluate({ tenantId, userId = null, metric }) {
  if (!METRICS.includes(metric)) {
    return { action: 'pass', checked: [], unknownMetric: true };
  }
  const tenant = String(tenantId);
  const user = userId == null ? null : String(userId);
  const rows = all(
    `SELECT * FROM quotas
      WHERE tenant_id = ? AND enabled = 1 AND metric = ?
        AND ((subject_type = 'tenant' AND subject_id = ?)
          OR (subject_type = 'user' AND subject_id = ?))`,
    [tenant, metric, tenant, user || '\u0000no-user\u0000']
  );
  const checked = [];
  let worst = 'pass';
  for (const r of rows) {
    const isUserLevel = r.subject_type === 'user';
    const c = usage.consumed(tenant, {
      userId: isUserLevel ? r.subject_id : null,
      metric: r.metric,
      period: r.period,
    });
    if (c.unknownMetric) {
      checked.push({ quotaId: r.id, metric: r.metric, period: r.period, mode: r.mode,
        subjectType: r.subject_type, used: null, limitValue: r.limit_value,
        note: '该 metric 未实装计量（不做假数据）' });
      continue;
    }
    const over = c.used >= Number(r.limit_value);
    const entry = {
      quotaId: r.id, metric: r.metric, period: r.period, mode: r.mode || 'block',
      subjectType: r.subject_type, used: c.used, limitValue: Number(r.limit_value), over,
    };
    checked.push(entry);
    if (over) {
      if ((r.mode || 'block') === 'block') worst = 'block';
      else if (worst !== 'block') worst = 'warn';
    }
  }
  const out = { action: worst, checked };
  if (worst !== 'pass') {
    out.reason = '配额已达标：' + checked.filter((c) => c.over)
      .map((c) => c.metric + '(' + c.period + ') ' + c.used + '/' + c.limitValue + ' · ' + c.mode).join('；');
  }
  return out;
}

/* ── 并发闸（P1-2）──────────────────────────────────────────────────── */

/**
 * 取本租户（/本用户）生效的并发配额行。
 * 与 `evaluate()` 用同一套条件，保证"页面上看到的"和"闸上判的"是同一批行。
 */
function concurrentRows(tenantId, userId) {
  return all(
    `SELECT * FROM quotas
      WHERE tenant_id = ? AND enabled = 1 AND metric = 'concurrent'
        AND ((subject_type = 'tenant' AND subject_id = ?)
          OR (subject_type = 'user' AND subject_id = ?))`,
    [String(tenantId), String(tenantId), userId == null ? '\u0000no-user\u0000' : String(userId)]
  );
}

/**
 * 进入一个在途回合 —— **判定 + 计数是原子的**（单线程事件循环里同步完成）。
 *
 * 为什么不能"先 evaluate 再 enter"分两步：两步之间存在一个窗口，
 * 两个请求可以都通过判定、然后都把计数加 1，于是双双冲破上限。
 * 判定与自增放在同一个同步函数里，这个窗口就不存在。
 *
 * 语义说明：与其它指标一致，用 `used >= limit` 判定 ——
 * 即"上限 5"表示**最多 5 个同时在跑**，第 6 个被拒。
 *
 * @returns {{ok:true, active:number, limit:number|null}
 *          |{ok:false, reason:'concurrent_blocked', active:number, limit:number, subjectType:string}}
 */
export function enterConcurrent({ tenantId, userId = null } = {}) {
  const tid = String(tenantId);
  const rows = concurrentRows(tid, userId);
  if (!rows.length) {
    // 没有配并发配额 = 不限流。仍然计数（/metrics 与页面要看到真实在途数）。
    const active = concurrency.enter(tid, userId);
    return { ok: true, active, limit: null, unlimited: true };
  }
  for (const r of rows) {
    const isUserLevel = r.subject_type === 'user';
    const used = isUserLevel ? concurrency.activeForUser(tid, r.subject_id) : concurrency.activeForTenant(tid);
    const limit = Number(r.limit_value);
    if (used >= limit) {
      const worst = r.mode || 'block';
      if (worst === 'warn') continue;      // warn 模式：只提醒不拦（与其它指标一致）
      return { ok: false, reason: 'concurrent_blocked', active: used, limit, subjectType: r.subject_type, quotaId: r.id, mode: worst };
    }
  }
  const active = concurrency.enter(tid, userId);
  const limits = rows.map((r) => Number(r.limit_value));
  return { ok: true, active, limit: limits.length ? Math.min(...limits) : null };
}

/**
 * 离开一个在途回合。**必须放在 `finally` 里**，且必须与 `enterConcurrent`
 * 的成功返回成对 —— 计数泄漏会表现为"没人用却报并发超限"。
 */
export function leaveConcurrent({ tenantId, userId = null } = {}) {
  return concurrency.leave(String(tenantId), userId);
}
