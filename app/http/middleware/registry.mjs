/**
 * 中间件注册表。
 *
 * ⚠️ 诚实约定：**实装状态与代码同源**。
 * M0 交付 `context` / `ratelimit`；M1 交付 `auth` / `tenant` / `rbac`；
 * M3 交付 `quota`（先检后放行）与 `audit`（收尾式记录）。
 *
 * 自 M3 起链上**没有占位项**：`x-sti-passthrough` 响应头不应再出现
 * （回归里有断言钉着 —— 它若出现，说明有中间件退化成了占位）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { createAuthMiddleware } from './auth.mjs';
import { createTenantMiddleware } from './tenant.mjs';
import { createRbacMiddleware } from './rbac.mjs';
import * as auditLog from '../../platform/governance/audit.mjs';
import * as metrics from '../../platform/observe/metrics.mjs';
// 通知的**产生方**入口（节流规则在那里，不在这里）—— 见文件头注释"产生方只有一个入口"。
import { emitQuotaBlocked } from '../../platform/notify/producers.mjs';
// 客户端 IP / 是否 HTTPS 的唯一判定处（trustProxy 时才采信转发头，P1-9）
import { clientIpOf, isSecureRequest } from '../../util/net.mjs';

/** 各中间件的交付状态（状态页 / 自检直接读这里，与代码同源） */
export const MIDDLEWARE_STATUS = [
  { name: 'context', state: 'active', milestone: 'M0', note: '请求上下文：requestId、链路记录、日志 span' },
  { name: 'ratelimit', state: 'active', milestone: 'M0', note: '内存滑动窗口限流（按 IP + 路由前缀；登录等爆破敏感路由单独收紧，默认 30/分钟，STI_RATE_LIMIT_LOGIN 可调）' },
  { name: 'auth', state: 'active', milestone: 'M1', note: '校验会话令牌 / API Key → 落身份；失败写审计并回 401' },
  { name: 'tenant', state: 'active', milestone: 'M1', note: '由身份推导 ctx.tenantId（仓储层过滤的唯一依据）' },
  { name: 'rbac', state: 'active', milestone: 'M1', note: '按路由 capability 判定权限；拒绝写审计并回 403' },
  { name: 'quota', state: 'active', milestone: 'M3', note: '配额先检后放行；超限 block 回 403 / warn 加响应头放行，均留审计' },
  { name: 'audit', state: 'active', milestone: 'M3', note: '收尾式记录：状态变更请求落哈希链（结果/耗时）；GET 只在出错时记录' },
];

/**
 * 限流阈值（模块级常量，**单一来源**）—— 与 `rateLimitPolicy()` 同源，
 * 避免"状态页说一套、实际跑一套"。
 */
const LIMIT_DEFAULT = Number(process.env.STI_RATE_LIMIT || 600);   // 每 IP 每分钟
// 爆破敏感路由**单独收紧**（默认 30 次/分钟/IP）。
// 为什么需要它：统一 600 只防得住泛洪，防不住"对着登录接口慢慢试口令"——
// 定向爆破每分钟几百次正好卡在旧阈值之下。
// 为什么是 30 而不是 5~10：本平台是**部门级内网**部署，一个 NAT 出口可能同时供
//   几十人早上集中登录；阈值过低会把正常用户一起挡掉。真正的单账号爆破由
//   `identity/service.mjs` 的**账号级指数退避**兜住（连错 5 次即 30s 起退避），
//   这里只负责"同一来源的持续尝试"这道粗筛。可用 STI_RATE_LIMIT_LOGIN 覆盖。
const LIMIT_LOGIN = Number(process.env.STI_RATE_LIMIT_LOGIN || 30);
/** 按 **路由 id** 收紧的限流表（键是 route.id，不是路径，避免路径改写/别名绕开） */
const ROUTE_LIMITS = { 'identity.login': LIMIT_LOGIN };

/**
 * @param {{config:object, kernel:object, identity:object, governance:object, notify?:object}} deps
 *   `notify` 只被 quota 中间件用来在**真拦下**配额时出站 `quota.blocked`（产生方见
 *   `platform/notify/producers.mjs`）。缺席 = 如实降级（不出站、不影响拦截结果）。
 * @returns {Record<string, (ctx)=>Promise<void>|void>}
 */
export function createMiddlewareRegistry(deps) {
  // ── 限流：内存滑动窗口（单进程，正好符合本项目的部署形态） ────────────
  const buckets = new Map();      // key → number[]（命中时间戳）
  const WINDOW_MS = 60_000;

  function rateLimitCheck(key, limit) {
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter((t) => now - t < WINDOW_MS);
    if (arr.length >= limit) {
      buckets.set(key, arr);
      return { ok: false, retryAfterMs: WINDOW_MS - (now - arr[0]) };
    }
    arr.push(now);
    buckets.set(key, arr);
    return { ok: true, remaining: limit - arr.length };
  }

  // 周期性清理，避免长期运行内存缓慢增长
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of buckets) {
      const keep = arr.filter((t) => now - t < WINDOW_MS);
      if (keep.length) buckets.set(k, keep); else buckets.delete(k);
    }
  }, WINDOW_MS);
  sweeper.unref?.();

  const auth = createAuthMiddleware({ identity: deps.identity, audit: auditLog });
  const tenant = createTenantMiddleware();
  const rbac = createRbacMiddleware({ audit: auditLog });

  const mw = {
    async context(ctx) {
      ctx.setHeader('x-request-id', ctx.requestId);
      ctx.chain.push('context');
      ctx.middleware.context = 'ok';
      // 客户端真实 IP 与是否安全通道：全链路（ratelimit / 审计 / cookie Secure）共用这一份。
      // trustProxy 来自配置，默认 false（转发头不可信）。
      const trustProxy = !!(deps.config && deps.config.values && deps.config.values.trustProxy);
      ctx.clientIp = clientIpOf(ctx.req, { trustProxy });
      ctx.secure = isSecureRequest(ctx.req, { trustProxy });
    },

    async ratelimit(ctx) {
      const ip = ctx.clientIp || 'unknown';
      const routeId = ctx.route ? ctx.route.id : '';
      // 有专属限额的路由（如登录）**只**占自己的桶 —— 这样它的专属额度不会被同前缀其他
      // 路由的流量稀释，也不会被"顺手调大默认值"悄悄放宽。
      const specific = ROUTE_LIMITS[routeId];
      const key = specific
        ? ip + '|route:' + routeId
        : ip + '|' + (ctx.route ? ctx.route.path.split('/').slice(0, 3).join('/') : '/');
      const r = rateLimitCheck(key, specific != null ? specific : LIMIT_DEFAULT);
      ctx.chain.push('ratelimit');
      if (!r.ok) {
        ctx.middleware.ratelimit = 'denied';
        ctx.deniedReason = 'rate_limited';
        auditLog.append({
          tenantId: ctx.tenantId || auditLog.ANONYMOUS_TENANT,
          userId: ctx.userId || null,
          action: 'ratelimit.block',
          resourceType: 'route',
          resourceId: ctx.route ? ctx.route.id : '',
          result: 'denied',
          detail: { path: ctx.url.pathname, method: ctx.req.method, ip },
        });
        ctx.json(429, {
          ok: false,
          error: { code: 'rate_limited', message: '请求过于频繁，请稍后再试' },
          retryAfterMs: r.retryAfterMs,
          requestId: ctx.requestId,
        });
        return 'stop';
      }
      ctx.middleware.ratelimit = 'ok';
      ctx.setHeader('x-ratelimit-remaining', String(r.remaining));
      return undefined;
    },

    auth,
    tenant,
    rbac,

    // ── M3：配额（先检后放行）────────────────────────────────────────
    // 只有**显式声明**了 `quotaMetric` 的路由才检查（目前是提交回合：turns）。
    // 其余路由直接放行 —— 对所有请求强加配额语义没有意义，还会让"配额"变成噪音。
    async quota(ctx) {
      ctx.chain.push('quota');
      const metric = ctx.route && ctx.route.quotaMetric;
      if (!metric) { ctx.middleware.quota = 'ok'; return undefined; }
      const gov = deps.governance;
      if (!gov || !gov.quotas) {
        // 装配缺失是缺陷不是策略：如实放行并在链状态里标注，绝不假装检查过
        ctx.middleware.quota = 'degraded';
        ctx.passthrough = [...(ctx.passthrough || []), 'quota'];
        return undefined;
      }
      const r = gov.quotas.evaluate({ tenantId: ctx.tenantId, userId: ctx.userId, metric });
      if (r.action === 'block') {
        ctx.middleware.quota = 'denied';
        ctx.deniedReason = 'quota_blocked';
        auditLog.append({
          tenantId: ctx.tenantId || auditLog.ANONYMOUS_TENANT,
          userId: ctx.userId || null,
          action: 'governance.quota.block',
          resourceType: 'quota',
          resourceId: metric,
          result: 'denied',
          detail: { routeId: ctx.route.id, metric, reason: r.reason, checked: r.checked },
        });
        metrics.inc('sti_quota_blocked_total', { metric });
        // 出站告警（§B10/B11：白名单事件必须有产生方）。**刻意不 await** ——
        // 一次 webhook 超时（默认 5s）不该把已经决定要拒绝的请求拖住；同理它也不影响判定。
        // 节流（同租户 + 同指标 10 分钟一次）由产生方掌握，见 platform/notify/producers.mjs。
        void emitQuotaBlocked(deps, {
          tenantId: ctx.tenantId, metric, reason: r.reason,
          routeId: ctx.route.id, subjectType: 'tenant',
        });
        ctx.json(403, {
          ok: false,
          error: {
            code: 'quota_blocked',
            message: '配额已达标，本次操作被治理策略拦截（可用管理员调整或等待周期重置）',
            detail: { metric, reason: r.reason },
          },
          requestId: ctx.requestId,
        });
        return 'stop';
      }
      if (r.action === 'warn') {
        ctx.middleware.quota = 'warn';
        ctx.setHeader('x-sti-quota-warning', '1');
        ctx.quotaWarnings = r.checked.filter((c) => c.over);
        auditLog.append({
          tenantId: ctx.tenantId || auditLog.ANONYMOUS_TENANT,
          userId: ctx.userId || null,
          action: 'governance.quota.warn',
          resourceType: 'quota',
          resourceId: metric,
          result: 'ok',
          detail: { routeId: ctx.route.id, metric, reason: r.reason },
        });
        return undefined;
      }
      ctx.middleware.quota = 'ok';
      return undefined;
    },

    // ── M3：审计（收尾式）────────────────────────────────────────────
    // 真正的落账在 `finalizeAudit()`（pipeline 在 handler 之后调用它），
    // 这里只做标记：告诉收尾器"这条链经过了 audit 中间件"。
    async audit(ctx) {
      ctx.chain.push('audit');
      ctx.auditTrail = { recorded: false };
      ctx.middleware.audit = 'ok';
      return undefined;
    },
  };

  /**
   * 审计收尾 —— pipeline.run 的 finally 里调用（含 handler 抛错的情况）。
   *
   * 记账口径（诚实且克制，审计链不是垃圾场）：
   *   · 只记**状态变更**（非 GET）；GET 成功不记 —— 读操作写满一条链只会稀释信噪比；
   *   · GET 出错（≥400）要记（"谁在反复探测某接口"是审计该回答的问题）；
   *   · result：有 deniedReason → denied；状态 ≥500 → error；其余 → ok。
   */
  function finalizeAudit(ctx, err = null) {
    if (!ctx || !ctx.auditTrail || ctx.auditTrail.recorded) return;
    ctx.auditTrail.recorded = true;
    const method = (ctx.req && ctx.req.method || '').toUpperCase();
    const status = ctx.res && ctx.res.statusCode ? ctx.res.statusCode : (err ? 500 : 0);
    if (method === 'GET' && status < 400 && !err) return;

    const result = ctx.deniedReason ? 'denied' : (status >= 500 || err ? 'error' : 'ok');
    auditLog.append({
      tenantId: ctx.tenantId || auditLog.ANONYMOUS_TENANT,
      userId: ctx.userId || null,
      action: ctx.route ? ctx.route.id : 'http.unmatched',
      resourceType: 'route',
      resourceId: ctx.route ? ctx.route.id : '',
      result,
      detail: {
        method,
        path: ctx.url ? ctx.url.pathname : '',
        status,
        elapsedMs: Date.now() - ctx.startedAt,
        ...(ctx.deniedReason ? { deniedReason: ctx.deniedReason } : {}),
        ...(ctx.quotaWarnings ? { quotaWarnings: ctx.quotaWarnings } : {}),
        ...(err ? { error: err && err.message } : {}),
        finalized: true,
      },
    });
  }

  /**
   * 指标收尾（P1-2）—— pipeline 的 finally 里调用，与 `finalizeAudit` 并列。
   *
   * 与审计收尾的区别（这也是为什么它是**另一个**函数，而不是塞进 finalizeAudit）：
   *   · 审计是**有条件**的（只记状态变更，GET 成功不记）—— 它的信噪比靠"少记"维持；
   *   · 指标是**无条件**的（每个请求都记）—— 它的价值靠"一个不漏"（rate 计算要连续）。
   * 把两种口径塞进一个函数，早晚会有人为了审计的信噪比顺手把指标也过滤掉。
   */
  function finalizeMetrics(ctx) {
    if (!ctx || !ctx.route) return;
    const status = ctx.res && ctx.res.statusCode ? ctx.res.statusCode : (ctx.deniedReason ? 403 : 0);
    metrics.recordHttpRequest({
      method: ctx.req && ctx.req.method,
      routeId: ctx.route.id,
      status,
      durationMs: ctx.startedAt ? Date.now() - ctx.startedAt : 0,
    });
  }

  return Object.assign(mw, { finalizeAudit, finalizeMetrics });
}

export function middlewareStatus() {
  return MIDDLEWARE_STATUS.map((m) => ({ ...m }));
}

/**
 * 限流策略（**与代码同源**）—— 状态页 / 自检 / 回归都读它。
 * 存在的理由：把"实际阈值"变成可读数据，而不是让文档或页面各自抄一份（抄的那份必然会漂）。
 */
export function rateLimitPolicy() {
  return {
    defaultPerMinute: LIMIT_DEFAULT,
    routeLimits: { ...ROUTE_LIMITS },
    note: '按 IP 的内存滑动窗口（窗口 60s，单进程）。登录等爆破敏感路由取 routeLimits 里的专属阈值；'
      + '单账号爆破另由身份服务的账号级指数退避兜住（见 identity/service.mjs loginGuard）。',
  };
}

/**
 * 把一条中间件链拆成「已实装」与「链上占位」两部分。
 *
 * 存在的理由：启动横幅若只打印 `context → ratelimit → auth → …`，会被读成
 * 「7 个中间件都在工作」——那是不诚实的。这里把占位项单独标出来，且标注
 * 它们计划在哪个里程碑交付，让运维一眼看清当前防护的真实边界。
 *
 * `state: 'partial'` 也会被算进占位 —— 因为它确实**不拦截**任何请求。
 *
 * @param {string[]} chain 例如 SCOPE_CHAINS.session
 * @returns {{active:string[], placeholder:Array<{name:string,milestone:string}>}}
 */
export function chainSummary(chain) {
  const byName = new Map(MIDDLEWARE_STATUS.map((m) => [m.name, m]));
  const active = [];
  const placeholder = [];
  for (const name of chain) {
    const meta = byName.get(name);
    if (meta && meta.state === 'active') active.push(name);
    else placeholder.push({ name, milestone: meta ? meta.milestone : '未知', note: meta ? meta.note : '' });
  }
  return { active, placeholder };
}

/** 供横幅/日志使用的一行文本，例如 `context → ratelimit ｜ 占位：auth(M1) …` */
export function formatChain(chain) {
  const { active, placeholder } = chainSummary(chain);
  let s = active.join(' → ');
  if (placeholder.length) {
    s += ' ｜ 占位（不拦截）：' + placeholder.map((p) => p.name + '(' + p.milestone + ')').join('、');
  }
  return s;
}
