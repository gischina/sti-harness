/**
 * 并发计数（内存）—— 配额 `concurrent` 的计量底座。
 *
 * 为什么这件事拖到 P1-2 才做，以及为什么现在**可以**做了：
 *   M3 时 `concurrent` 被刻意留在"未实装"（`consumed()` 如实返回 `used:0` +
 *   `unknownMetric:true`），理由写在 quotas.mjs 顶部：基于内存计数器的并发闸
 *   在**多实例**部署下是错的，而当时的路线图里还留着"横向扩展"的可能性。
 *   现在那条可能性已经收敛掉了 —— 单进程是本项目的**架构承诺**
 *   （architecture.md §10.1），于是"内存计数"从"临时方案"变成了"正确答案"：
 *   它精确、零依赖、无协调开销，且与部署形态一致。
 *
 * 计数口径：
 *   · 键是 `tenantId|userId`（用户级），租户级 = 该租户下所有用户之和；
 *   · **只统计在途回合**（提交开始 → 收流结束/失败/客户端断开）。这是
 *     "并发"在这个产品里唯一有意义的定义：同时有多少轮对话在跑。
 *   · `enter()` / `leave()` 必须**成对**，且 `leave` 放在 `finally` 里 ——
 *     否则一次异常就会让计数永久偏高，表现为"明明没人用却报并发超限"，
 *     这类泄漏比"没有闸"更难查。
 *
 * ⚠️ 诚实边界：进程重启即归零。重启瞬间"在途"本来也确实为 0（旧回合已随进程消亡），
 *    所以这不是失真，而是事实。但如果将来真上了多实例，这个模块必须整体重写
 *    （需要一个共享租约），而不是加个开关。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */

/** key(`tenantId|userId`) → 在途回合数 */
const counts = new Map();
/** 观察者：计数变化时回调（用于把 gauge 报给 /metrics）。装配层注入，未注入则静默。 */
let observer = null;

function keyOf(tenantId, userId) {
  return String(tenantId == null ? '' : tenantId) + '|' + (userId == null ? '' : String(userId));
}

function totalAll() {
  let n = 0;
  for (const v of counts.values()) n += v;
  return n;
}

function notifyObserver() {
  if (typeof observer !== 'function') return;
  try { observer({ total: totalAll(), tenants: counts.size }); } catch { /* 观察者异常不影响计数 */ }
}

/** 注入观察者（main.mjs 用它把 `sti_active_turns` gauge 接到 /metrics）。 */
export function setObserver(fn) {
  observer = typeof fn === 'function' ? fn : null;
  notifyObserver();
}

/** 进入一个在途回合。**不做上限判定** —— 判定在 quotas.enterConcurrent 里（它知道配额）。 */
export function enter(tenantId, userId) {
  const k = keyOf(tenantId, userId);
  const next = (counts.get(k) || 0) + 1;
  counts.set(k, next);
  notifyObserver();
  return next;
}

/** 离开一个在途回合。**必须与 enter 成对**（放在 finally 里）。返回离开后的值。 */
export function leave(tenantId, userId) {
  const k = keyOf(tenantId, userId);
  const cur = counts.get(k) || 0;
  const next = Math.max(0, cur - 1);
  if (next) counts.set(k, next); else counts.delete(k);
  notifyObserver();
  return next;
}

/** 某个用户在途回合数 */
export function activeForUser(tenantId, userId) {
  return counts.get(keyOf(tenantId, userId)) || 0;
}

/** 某个租户在途回合数（该租户下所有用户之和） */
export function activeForTenant(tenantId) {
  const prefix = String(tenantId == null ? '' : tenantId) + '|';
  let n = 0;
  for (const [k, v] of counts) if (k.startsWith(prefix)) n += v;
  return n;
}

/** 明细快照（管理页与回归用） */
export function snapshot() {
  return { total: totalAll(), byKey: Object.fromEntries(counts) };
}

/** 测试用：清零。生产不调用。 */
export function reset() {
  counts.clear();
  notifyObserver();
}
