/**
 * 路由表 —— **全站唯一真源**。
 *
 * 每条路由声明 `{ id, method, path, scope, capability }`：
 *   · `scope`      → 决定走哪条中间件链（见 pipeline.mjs），**不在 handler 里写鉴权**
 *   · `capability` → 声明所需权限键（M1 的 RBAC 中间件统一执行）
 *
 * 因此顶栏、侧栏、标题、面包屑、权限校验全部可以从这张表推导出来，
 * 改一处不会在其他地方漂移（沿用同权利人早期作品的 ROUTES 单点定义经验）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { errors } from '../util/errors.mjs';

export const SCOPES = ['public', 'session', 'admin'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function createRouter() {
  const routes = [];

  function add(def) {
    if (!def || !def.id) throw new Error('路由必须声明 id');
    if (!METHODS.includes(def.method)) throw new Error(`路由 ${def.id} 的 method 非法：${def.method}`);
    if (typeof def.path !== 'string' || !def.path.startsWith('/')) {
      throw new Error(`路由 ${def.id} 的 path 必须以 / 开头`);
    }
    if (!SCOPES.includes(def.scope)) throw new Error(`路由 ${def.id} 的 scope 非法：${def.scope}`);
    if (typeof def.handler !== 'function') throw new Error(`路由 ${def.id} 缺少 handler`);
    if (routes.some((r) => r.id === def.id)) throw new Error(`路由 id 重复：${def.id}`);

    const segs = def.path.split('/').filter(Boolean);
    routes.push({
      id: def.id,
      method: def.method,
      path: def.path,
      scope: def.scope,
      capability: def.capability || [],
      // 配额指标声明（M3）：quota 中间件只对显式声明了它的路由做配额检查。
      // ⚠️ 这里必须显式保留 —— add() 是白名单挑字段，漏掉的话中间件拿到的
      //    永远是 undefined，然后"安静地放行"（比启动失败难查得多）。
      quotaMetric: def.quotaMetric || null,
      summary: def.summary || '',
      milestone: def.milestone || '',
      handler: def.handler,
      _segs: segs,
      _params: segs.filter((s) => s.startsWith(':')).map((s) => s.slice(1)),
    });
  }

  /** 批量注册：addAll([...]) */
  function addAll(defs) { for (const d of defs) add(d); }

  /**
   * 匹配路由。静态段优先于参数段（避免 /api/kernel/status 被 /api/kernel/:id 抢走）。
   * @returns {{route:object, params:object}|null}
   */
  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const hits = [];
    for (const r of routes) {
      if (r.method !== method) continue;
      if (r._segs.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const s = r._segs[i];
        if (s.startsWith(':')) params[s.slice(1)] = safeDecode(parts[i]);
        else if (s !== parts[i]) { ok = false; break; }
      }
      if (ok) hits.push({ route: r, params, wildcards: r._params.length });
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.wildcards - b.wildcards);
    return { route: hits[0].route, params: hits[0].params };
  }

  /** 该路径存在但方法不对时，返回允许的方法（用于 405） */
  function allowedMethods(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const out = new Set();
    for (const r of routes) {
      if (r._segs.length !== parts.length) continue;
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const s = r._segs[i];
        if (!s.startsWith(':') && s !== parts[i]) { ok = false; break; }
      }
      if (ok) out.add(r.method);
    }
    return [...out];
  }

  /** 可序列化的路由表（状态页直接展示这张表，杜绝"文档与代码漂移"） */
  function list() {
    return routes.map((r) => ({
      id: r.id, method: r.method, path: r.path, scope: r.scope,
      capability: r.capability, summary: r.summary, milestone: r.milestone,
    }));
  }

  function stats() {
    const byScope = {};
    const byMilestone = {};
    for (const r of routes) {
      byScope[r.scope] = (byScope[r.scope] || 0) + 1;
      const m = r.milestone || '(未标注)';
      byMilestone[m] = (byMilestone[m] || 0) + 1;
    }
    return { total: routes.length, byScope, byMilestone };
  }

  return { add, addAll, match, allowedMethods, list, stats, routes };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** 路由表自身的守卫：任何一条 handler 抛错都必须收敛成 HTTP 语义 */
export function notFound() { return errors.notFound('没有这个接口'); }
