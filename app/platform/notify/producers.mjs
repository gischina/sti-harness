/**
 * 通知的**产生方** —— 平台"真的发生了某件事"时把事件送进通知层的**唯一入口**。
 *
 * 为什么单独成文件（而不是在拦截点就地 `notify.emit`）：
 *   · **节流策略只有一份**。`quota.blocked` 是"会成串发生"的事件：
 *     一个租户撞上配额后，接下来每一次提交都会被拦。
 *     逐次出站 = 给运维的企业微信/钉钉刷屏，刷屏的告警等于没有告警。
 *   · **产生方要能被对账**。`notify/service.mjs` 的 `NOTIFY_EVENT_PRODUCERS` 声明"谁产生这个事件"，
 *     回归会**双向**核验（声明的文件里必须真有这个事件名；全仓字面 emit 的事件集必须恰好等于声明的那批）。
 *     入口收敛在一处，这张表才不会随重构变假。
 *
 * ⚠️ 节流合掉的是**通知**，不是**事实**。每一次配额拦截都仍然逐条进审计
 *    （`governance.quota.block` 与 403 响应）—— 所以"被合并"不会让任何事变得查不到，
 *    只是不再把同一条消息往告警通道里灌。反过来也成立：**告警通道安静不代表没发生**。
 *
 * ⚠️ 出站是**尽力而为**：它不阻塞、不影响判定本身。配额拦截必须立刻把 403 返回给调用方，
 *    让一次 webhook 超时拖慢（或改变）拦截结果是错误的优先级 —— 同"审计留痕失败不影响拦截本身"。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */

/**
 * 节流窗口：同一 (租户, 事件, dedupeKey) 在窗口内**最多出站一次**。
 *
 * 为什么是 10 分钟：它要跨过"一个人在页面上反复点提交"与"一个脚本在刷"这两种形态，
 * 又不至于长到让下一次**真正不同**的告警被吞掉（不同 metric 各有各的键，互不影响）。
 * ⚠️ 窗口是**进程内存**（与并发配额同一理由：本项目是单进程部署）。
 *    重启即重新计时；跨进程的节流要先有共享状态，那是横向扩的前提，不是这里能补的。
 */
export const QUOTA_BLOCKED_COOLDOWN_MS = 10 * 60 * 1000;

/** 取通知服务；**没装配就如实返回 null**（装配缺陷不该以"崩掉一次业务请求"的形式暴露）。 */
function notifyOf(deps) {
  const n = deps && deps.notify;
  return n && typeof n.emit === 'function' ? n : null;
}

/** 出站的安全包装：未装配、抛错、被节流都收敛成**可读的返回**，绝不向业务路径抛。 */
function safeEmit(notify, message, unwiredNote) {
  if (!notify) return Promise.resolve({ ok: false, skipped: 'notify_unwired', note: unwiredNote });
  if (message.tenantId == null || String(message.tenantId) === '') {
    return Promise.resolve({ ok: false, skipped: 'no_tenant', note: '没有租户，无法决定发给哪个组织的渠道' });
  }
  return Promise.resolve()
    .then(() => notify.emit(message))
    .catch((e) => ({ ok: false, skipped: 'emit_failed', error: (e && e.message) || String(e) }));
}

/**
 * 配额拦截（`quota.blocked`）。
 *
 * 两个调用点（都是平台**真正拦下请求**的地方，也是唯一两处）：
 *   · `http/middleware/registry.mjs` 的 quota 中间件 —— turns / tokens 超限 → 403；
 *   · `http/routes/kernel.mjs` 的并发闸 —— 在途回合数超限（判定与自增原子，所以不在中间件里）。
 * 两处共用本函数，节流规则因此只有一份。
 *
 * @param {object} p
 * @param {string} p.metric  被拦的指标（turns / input_tokens / concurrent …）—— 也是节流键
 * @param {string} [p.reason] 人话原因（`note` 会进接收端直接渲染的那一行）
 */
export function emitQuotaBlocked(deps, { tenantId, metric, reason = '', routeId = '', subjectType = null }) {
  const note = '配额拦截：' + (metric || '未知指标')
    + (subjectType ? '（' + subjectType + ' 级）' : '')
    + ' —— ' + (reason || '已达上限')
    + (routeId ? '［路由 ' + routeId + '］' : '');
  return safeEmit(notifyOf(deps), {
    tenantId,
    event: 'quota.blocked',
    cooldownMs: QUOTA_BLOCKED_COOLDOWN_MS,
    // 按**指标**分键：turns 被限住不代表 token 也被限住，两条告警说的是两件事
    dedupeKey: String(metric || ''),
    payload: { metric, routeId, subjectType, reason, note },
  }, '通知服务未装配（装配缺陷）：配额拦截已如实返回 403 并留审计，只是没有人会收到告警');
}
