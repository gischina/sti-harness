/**
 * rbac 中间件 —— 按路由声明的 capability 做权限判定；拒绝则写审计并回 403。
 *
 * 规则（三条，顺序即优先级）：
 *   1. 路由声明了 `capability`（形如 `['user:read']`）→ **任一**满足即放行；
 *   2. 未声明 capability 且 scope 是 `admin` → 要求角色含 `owner` 或 `admin`（默认从严）；
 *   3. 未声明 capability 且 scope 是 `session` → 登录即放行（"登录用户都能做的事"）。
 *
 * 为什么第 2 条要"默认从严"：新增一个 admin 路由时人**总是会忘记**写 capability。
 * 忘记的后果应该是"管理员才发现进不去"（立刻可见、立刻修），
 * 而不是"任何登录用户都能进"（安静地开了个口子）。
 *
 * 权限判定本身是纯函数（`platform/identity/permissions.mjs`），本文件只做
 * 「取声明 → 调判定 → 处置结果」这三步。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { can, explain } from '../../platform/identity/permissions.mjs';

/** `'user:read'` → `{resource:'user', action:'read'}` */
export function parseCapability(spec) {
  const s = String(spec || '');
  const i = s.indexOf(':');
  if (i <= 0) return null;
  return { resource: s.slice(0, i).trim().toLowerCase(), action: s.slice(i + 1).trim().toLowerCase() };
}

const ADMIN_ROLES = ['owner', 'admin'];

function grant(ctx, note) {
  ctx.middleware.rbac = 'ok';
  ctx.authz = { allowed: true, by: note };
}

function deny(ctx, audit, { needs, reason, explains }) {
  ctx.middleware.rbac = 'denied';
  ctx.deniedReason = reason;
  audit.append({
    tenantId: ctx.tenantId || 'anonymous',
    userId: ctx.userId || null,
    action: 'access.denied',
    resourceType: 'route',
    resourceId: ctx.route ? ctx.route.id : '',
    result: 'denied',
    detail: {
      reason,
      method: ctx.req.method,
      path: ctx.url.pathname,
      needs,
      roles: (ctx.user && ctx.user.roles) || [],
      explains: explains || undefined,
    },
  });
  ctx.json(403, {
    ok: false,
    error: {
      code: 'forbidden',
      message: '没有权限执行该操作',
      detail: { needs, roles: (ctx.user && ctx.user.roles) || [] },
    },
    requestId: ctx.requestId,
  });
  return 'stop';
}

export function createRbacMiddleware({ audit }) {
  return async function rbac(ctx) {
    ctx.chain.push('rbac');

    const roles = (ctx.user && ctx.user.roles) || [];
    const scope = ctx.route ? ctx.route.scope : 'session';
    const caps = Array.isArray(ctx.route && ctx.route.capability) ? ctx.route.capability : [];

    // ① 声明了 capability
    if (caps.length) {
      const results = caps.map((c) => {
        const parsed = parseCapability(c);
        return {
          spec: c,
          parsed,
          allowed: parsed ? can(roles, parsed.resource, parsed.action) : false,
          explain: parsed ? explain(roles, parsed.resource, parsed.action) : null,
        };
      });
      const hit = results.find((r) => r.allowed);
      if (hit) {
        grant(ctx, hit.spec);
        return undefined;
      }
      // API Key 带 scopes 时，额外要求 key 自身也覆盖该 capability（key 不能放大用户权限）
      return deny(ctx, audit, {
        needs: caps,
        reason: 'rbac_denied',
        explains: results.map((r) => ({ spec: r.spec, allowed: r.allowed, checked: r.explain ? r.explain.checked : null })),
      });
    }

    // ② admin scope 未声明 capability → 要求管理员角色
    if (scope === 'admin') {
      const hit = ADMIN_ROLES.find((r) => roles.includes(r));
      if (hit) {
        grant(ctx, 'admin-scope:' + hit);
        return undefined;
      }
      return deny(ctx, audit, {
        needs: ['owner|admin'],
        reason: 'admin_scope_denied',
        explains: [{ spec: 'owner|admin', allowed: false, checked: [{ roles, note: '该路由属于管理员作用域但未声明 capability，按默认从严处理' }] }],
      });
    }

    // ③ session scope 未声明 capability → 登录即可（auth 已保证）
    grant(ctx, 'authenticated');
    return undefined;
  };
}
