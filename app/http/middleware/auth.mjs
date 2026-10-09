/**
 * auth 中间件 —— 校验令牌，落身份到 ctx。
 *
 * 位置约定：只挂在 `session` / `admin` 两条链上（`public` 链没有它）。
 * **handler 里永远不写鉴权** —— 这点从 M0 就定下了，M1 只是把占位填实。
 *
 * 失败语义：
 *   · 没带令牌   → 401 `unauthorized`（"请先登录"）
 *   · 令牌无效/过期/已吊销 → 401 `unauthorized`（**不区分**具体原因，避免给探测者信息）
 *   · 账号被停用 → 401（同上，不额外提示"你被停用了"）
 *   · Cookie 认证 + 状态变更方法 + 跨站来源 → 403 `csrf_blocked`（见下方 CSRF 段）
 * 前三种都写审计（`result='denied'`），因为"谁在什么时候尝试访问被拒"本身是治理信号。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { extractToken } from '../../platform/identity/tokens.mjs';
import { ANONYMOUS_TENANT } from '../../platform/governance/audit.mjs';

/** 状态变更方法 —— CSRF 只对这些方法有意义（GET 必须无副作用） */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF 判定（纵深防御）。**只对 Cookie 认证生效** ——
 * `Authorization` / `x-sti-token` 是脚本显式带的，浏览器不会自动附加，天然不受 CSRF 影响。
 *
 * 第一道防线其实已经在了：会话 cookie 带 `SameSite=Lax`，现代浏览器不会把它
 * 带到跨站的 POST 上 —— 也就是说跨站表单提交根本拿不到 cookie，会先被上面的"无令牌"拦下。
 * 这里再加一道**显式**校验，理由是：
 *   · SameSite 是浏览器行为，客户端不受我们控制（老浏览器、非浏览器客户端）；
 *   · 显式判定能留下一条可审计的记录，而"cookie 恰好没带上"是静默的。
 *
 * 判定顺序（浏览器发什么就信什么，不发就不拦 —— 否则会误伤 curl 这类客户端）：
 *   1. 有 `Sec-Fetch-Site` → 只接受 `same-origin` / `same-site` / `none`；`cross-site` 拒绝；
 *   2. 否则有 `Origin` → 其 host 必须与请求 Host 相同；
 *   3. 两者都没有 → 放行（非浏览器客户端，不适用 CSRF 威胁模型）。
 *
 * @returns {{ok:boolean, reason:string, source:string}}
 */
export function csrfVerdict(req) {
  const h = (req && req.headers) || {};
  const host = String(h.host || h[':authority'] || '');

  const site = String(h['sec-fetch-site'] || '').trim().toLowerCase();
  if (site) {
    if (site === 'cross-site') return { ok: false, reason: 'csrf_cross_site', source: 'sec-fetch-site' };
    return { ok: true, reason: 'sec-fetch-site:' + site, source: 'sec-fetch-site' };
  }

  const origin = String(h.origin || '').trim();
  if (origin && origin !== 'null') {
    let oHost;
    try { oHost = new URL(origin).host; } catch { return { ok: false, reason: 'csrf_bad_origin', source: 'origin' }; }
    if (!host || oHost !== host) return { ok: false, reason: 'csrf_origin_mismatch', source: 'origin' };
    return { ok: true, reason: 'origin-same-host', source: 'origin' };
  }

  return { ok: true, reason: 'no_origin_header', source: 'none' };
}

/** 认证失败的统一出口：写审计 + 回 401（不泄漏原因差异） */
function deny(ctx, audit, reason) {
  ctx.middleware.auth = 'denied';
  ctx.deniedReason = reason;
  audit.append({
    tenantId: ANONYMOUS_TENANT,
    userId: null,
    action: 'auth.authenticate',
    resourceType: 'route',
    resourceId: ctx.route ? ctx.route.id : '',
    result: 'denied',
    detail: { reason, method: ctx.req.method, path: ctx.url.pathname },
  });
  ctx.json(401, {
    ok: false,
    error: { code: 'unauthorized', message: '未登录或会话已失效，请重新登录' },
    requestId: ctx.requestId,
  });
}

export function createAuthMiddleware({ identity, audit }) {
  return async function auth(ctx) {
    ctx.chain.push('auth');

    const { token, via } = extractToken(ctx.req);
    if (!token) {
      deny(ctx, audit, 'no_token');
      return 'stop';
    }

    const id = identity.authenticate(token);
    if (!id) {
      deny(ctx, audit, 'invalid_token');
      return 'stop';
    }

    // ── CSRF：Cookie 认证 + 状态变更方法 → 必须同源 ────────────────────
    if (via === 'cookie' && UNSAFE_METHODS.has(String(ctx.req.method || '').toUpperCase())) {
      const v = csrfVerdict(ctx.req);
      if (!v.ok) {
        ctx.middleware.auth = 'denied';
        ctx.deniedReason = v.reason;
        audit.append({
          tenantId: id.orgId,
          userId: id.user.id,
          action: 'auth.csrf',
          resourceType: 'route',
          resourceId: ctx.route ? ctx.route.id : '',
          result: 'denied',
          detail: {
            reason: v.reason, source: v.source,
            method: ctx.req.method, path: ctx.url.pathname,
            origin: String((ctx.req.headers || {}).origin || ''),
            host: String((ctx.req.headers || {}).host || ''),
          },
        });
        ctx.json(403, {
          ok: false,
          error: {
            code: 'csrf_blocked',
            message: '跨站请求已被拒绝。浏览器脚本请改用 Authorization 头携带令牌；'
              + 'Cookie 认证只接受同源的状态变更请求。',
          },
          requestId: ctx.requestId,
        });
        return 'stop';
      }
      ctx.middleware.csrf = 'ok';
    }

    ctx.user = id.user;
    ctx.userId = id.user.id;
    ctx.tenantId = id.orgId;
    ctx.auth = {
      /**
       * ⚠️ 这两个字段**不是一回事**，早先把它们混成一个 `via` 导致过误判：
       *   · `via`        —— 令牌**怎么带过来的**：authorization | x-sti-token | cookie
       *   · `credential` —— 令牌**是什么东西**：session | api-key
       * CSRF 判定必须看 `via`（只有 cookie 会被浏览器自动附加）；
       * 而"这是不是集成用的长期密钥"要看 `credential`。合成一个字段就会问错问题。
       */
      via,                       // 携带方式
      credential: id.via,        // 凭证种类
      sessionId: id.sessionId,
      apiKeyId: id.apiKeyId,
      scopes: id.scopes,
    };
    ctx.middleware.auth = 'ok';
    return undefined;
  };
}
