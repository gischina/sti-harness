/**
 * tenant 中间件 —— 由身份推导租户，并把它固定到 ctx 上。
 *
 * 为什么单独一件而不是塞进 auth：**多租户隔离是独立关注点**。
 * 一旦将来支持"一个用户可访问多个组织"（切换组织视图），
 * 唯一要改的就是这里（从 ctx 上的"当前组织"读，而不是从用户记录读），
 * auth 与所有 handler 都不用动。
 *
 * 契约：本中间件执行**之后**，`ctx.tenantId` 必定是一个非空字符串。
 * 仓储层所有查询都以它为过滤条件 —— 这就是逻辑隔离的落点。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { errors } from '../../util/errors.mjs';

export function createTenantMiddleware() {
  return async function tenant(ctx) {
    ctx.chain.push('tenant');

    const orgId = ctx.user && ctx.user.orgId;
    if (!orgId) {
      // 走到这里说明链的装配错了（tenant 必须排在 auth 之后），属于代码缺陷而不是用户输入问题。
      ctx.middleware.tenant = 'denied';
      throw errors.internal('tenant 中间件在未认证请求上执行 —— 请检查中间件链顺序（auth 必须在前）');
    }

    ctx.tenantId = orgId;

    // API Key 若声明了 scopes，则与角色权限**取交集**（key 只能是用户权限的子集，不能放大）
    ctx.scopes = Array.isArray(ctx.auth && ctx.auth.scopes) ? ctx.auth.scopes : [];

    ctx.middleware.tenant = 'ok';
    return undefined;
  };
}
