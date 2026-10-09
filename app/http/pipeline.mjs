/**
 * 中间件管线 —— 链由路由的 `scope` 推导，**handler 内不写鉴权**。
 *
 * scope 分级（由弱到强）：
 *   public  ：无需登录（健康检查、自检、登录页数据、静态兜底）
 *   session ：需要登录（默认；会话、知识、能力等业务接口）
 *   admin   ：需要管理角色（组织/用户/角色/凭据/平台设置）
 *
 * 顺序即执行顺序；任一中间件返回 'stop' 则终止（它自己负责已写出响应）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { createMiddlewareRegistry } from './middleware/registry.mjs';
import * as metrics from '../platform/observe/metrics.mjs';
import { log } from '../log.mjs';

export const SCOPE_CHAINS = {
  public: ['context', 'ratelimit'],
  session: ['context', 'ratelimit', 'auth', 'tenant', 'rbac', 'quota', 'audit'],
  admin: ['context', 'ratelimit', 'auth', 'tenant', 'rbac', 'quota', 'audit'],
};

export function createPipeline(deps) {
  const registry = createMiddlewareRegistry(deps);

  return {
    registry,
    chains: SCOPE_CHAINS,

    /**
     * 执行一条路由的中间件链，然后调用 handler。
     * 任何环节抛错都在这里收敛成 HTTP 响应（不留未捕获异常打挂进程）。
     */
    async run(ctx) {
      const scope = ctx.route ? ctx.route.scope : 'public';
      const chain = SCOPE_CHAINS[scope] || SCOPE_CHAINS.public;

      // 在途请求计数（`/metrics` 的 `sti_process_inflight_requests`）。
      // 为什么在这里配对、而不放进 finalizeMetrics：那个函数对未匹配路由**提前返回**，
      // 与"进入时加、离开时减"不成对，会把计数泄漏成负数/偏高。放到 `run` 的进出口则天然对称。
      metrics.beginInflight();
      try {
        for (const name of chain) {
          const fn = registry[name];
          if (typeof fn !== 'function') {
            log.error('中间件链引用了未注册的中间件：' + name);
            throw new Error('中间件未注册：' + name);
          }
          const r = await fn(ctx);
          if (r === 'stop') return;
        }

        // 如实自报家门：这条链上还有哪些中间件没实装
        if (ctx.passthrough && ctx.passthrough.length) {
          ctx.setHeader('x-sti-passthrough', ctx.passthrough.join(','));
        }

        await ctx.route.handler(ctx);
      } catch (e) {
        if (ctx.res.headersSent) {
          log.error('[' + ctx.requestId + '] handler 已写出响应后才抛错：' + (e && e.message));
          try { ctx.res.end(); } catch { /* ignore */ }
          return;
        }
        ctx.handleError(e);
      } finally {
        // 在途计数必须与上面的 beginInflight 成对（含中间件 'stop' 提前返回、handler 抛错两种情况）
        metrics.endInflight();
        // 审计收尾：成功与抛错都要走到（含中间件 'stop' 提前返回的情况）
        try {
          if (typeof registry.finalizeAudit === 'function') registry.finalizeAudit(ctx);
        } catch (e) {
          log.error('[' + ctx.requestId + '] 审计收尾失败：' + (e && e.message));
        }
        // 指标收尾：与审计**口径不同**（无条件记录），因此单独一步，见 registry.finalizeMetrics
        try {
          if (typeof registry.finalizeMetrics === 'function') registry.finalizeMetrics(ctx);
        } catch (e) {
          log.error('[' + ctx.requestId + '] 指标收尾失败：' + (e && e.message));
        }
        const elapsed = Date.now() - ctx.startedAt;
        if (elapsed > 1000) {
          log.warn('[' + ctx.requestId + '] 慢请求 ' + elapsed + 'ms：' + ctx.req.method + ' ' + ctx.url.pathname);
        }
      }
    },
  };
}
