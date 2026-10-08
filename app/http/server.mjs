/**
 * HTTP 服务器装配。
 *
 * 请求分流：
 *   /api/*        → 路由表匹配 → 中间件链 → handler（本平台自己的接口）
 *   /upstream/*   → 原样转发给上游内核（页面请求走这条，避免跨域）
 *   其它          → 静态托管 public/
 * WS upgrade：
 *   已接入内核时，/api/* 的 upgrade 桥到上游（透明字节管道）；
 *   未接入时不注册，浏览器连接失败即显示"实时流不可用"——这是真实结果。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import http from 'node:http';
import { createRouter } from './router.mjs';
import { createContext } from './context.mjs';
import { createPipeline } from './pipeline.mjs';
import { serveStatic } from './static.mjs';
import { applySecurityHeaders } from './security-headers.mjs';
import { registerRoutes, PLANNED_ROUTES } from './routes/index.mjs';
import { extractToken } from '../platform/identity/tokens.mjs';
import { log } from '../log.mjs';

/**
 * 浏览器请求是否同源（2026-10 安全评审 P0-1：透传写操作的 CSRF 闸）。
 *
 * 判据：浏览器同源请求带的 `Origin`（现代浏览器总有）或兜底的 `Referer`，
 * 其主机必须与本次请求的 `Host` 一致。两者都没有 = 非浏览器或信息不足，
 * 对 cookie 认证的写请求按不通过处理。
 */
function isSameOriginBrowserRequest(req) {
  const host = req.headers.host;
  if (!host) return false;
  const candidate = req.headers.origin || req.headers.referer;
  if (!candidate) return false;
  try { return new URL(candidate).host === host; } catch { return false; }
}

/** WebSocket 握手被拒：直接在 socket 上写 HTTP 错误响应后关闭。 */
function rejectUpgrade(socket, status) {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Gateway';
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* socket 已坏 */ }
  socket.destroy();
}

export function createServer(deps) {
  const router = createRouter();
  // `notify` 要进管线：quota 中间件在**真拦下**一次配额时出站 `quota.blocked`
  // （产生方见 platform/notify/producers.mjs）。缺装配时那边会如实降级（不出站、不抛错）。
  const pipeline = createPipeline({
    config: deps.config, kernel: deps.kernel, identity: deps.identity,
    governance: deps.governance, notify: deps.notify,
  });
  registerRoutes(router, { ...deps, router, pipeline });

  // ⚠️ WS 桥的处理函数**故意不在这里抓**（0.21.3）——它挪到 `upgrade` 事件里现取，
  // 理由见那里。这里只留一句，免得后来者"顺手补回去"。

  function sendPlain(res, status, code, message) {
    if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: { code, message } }));
  }

  /**
   * 上游透传的收口处理。流程见调用处注释：认证 → 路径闸 → 同源闸 → 审计 → 转发。
   */
  function handleUpstream(req, res, url) {
    const rest = url.pathname.slice('/upstream'.length);

    // ① 平台认证（会话令牌或 API Key）—— 未登录一律不借平台凭据
    const extracted = extractToken(req);
    const auth = deps.identity && deps.identity.authenticate(extracted.token);
    if (!auth) {
      sendPlain(res, 401, 'unauthorized', '请先登录平台后再访问上游透传接口');
      return;
    }

    // ② 只允许上游 /api/ 下的路径；挡掉穿越段与控制字符
    //    （url.pathname 已解码，%2e%2e 在这里就是 '..'）
    if (!rest.startsWith('/api/') || rest.includes('..') || /[\r\n]/.test(rest)) {
      sendPlain(res, 403, 'upstream_path_denied', '透传只允许上游 /api/ 下的路径');
      return;
    }

    // ③ cookie 认证的非安全方法必须同源 —— 防恶意网页"读不到响应、但已借凭据写了上游"。
    //    Bearer / x-sti-token 是调用方显式携带的凭证，不受此限。
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (unsafe && extracted.via === 'cookie' && !isSameOriginBrowserRequest(req)) {
      sendPlain(res, 403, 'csrf_origin_mismatch', '跨源写操作被拒绝（Origin/Referer 与平台不同源）');
      return;
    }

    // ④ 审计：响应结束时记录目标、状态与耗时，透传不是无痕通道
    const t0 = Date.now();
    res.on('finish', () => {
      try {
        deps.governance.audit.append({
          tenantId: auth.orgId,
          userId: auth.user ? auth.user.id : null,
          action: 'upstream.forward',
          resourceType: 'upstream',
          resourceId: rest,
          result: res.statusCode >= 500 ? 'error' : (res.statusCode >= 400 ? 'denied' : 'ok'),
          detail: {
            method: req.method, path: rest, status: res.statusCode,
            elapsedMs: Date.now() - t0, authVia: extracted.via,
          },
        });
      } catch { /* 审计失败不阻塞透传 */ }
    });

    Promise.resolve()
      .then(() => deps.kernel.forwardRequest(req, res, rest, url.search))
      .catch((e) => {
        sendPlain(res, 502, 'upstream_unavailable', (e && e.message) || 'upstream unavailable');
      });
  }

  const server = http.createServer((req, res) => {
    // 安全响应头必须最先设：writeHead 之后再设会抛，且要保证每条出口（API/静态/透传）都带上。
    // 具体 handler 若在 writeHead 里给了同名头，以它为准（writeHead 参数优先于 setHeader）。
    applySecurityHeaders(req, res);

    let url;
    try {
      url = new URL(req.url, 'http://placeholder');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request url');
      return;
    }

    // 上游透传 —— 2026-10 安全评审 P0-1：以前裸转发，平台凭据被任何
    // 未登录调用方借用、且无审计。现在四道收口：平台认证 → 仅 /api/ 前缀 →
    // cookie 写操作同源闸 → 逐请求审计。
    if (url.pathname.startsWith('/upstream/')) {
      handleUpstream(req, res, url);
      return;
    }

    // 本平台接口
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const hit = router.match(req.method, url.pathname);
      if (!hit) {
        const allow = router.allowedMethods(url.pathname);
        if (allow.length) {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: allow.join(', ') });
          res.end(JSON.stringify({ ok: false, error: { code: 'method_not_allowed', message: '该路径不支持 ' + req.method, allow } }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: false,
          error: {
            code: 'not_found',
            message: '没有这个接口：' + url.pathname,
            hint: '完整接口清单见 GET /api/system/routes',
          },
        }));
        return;
      }
      const ctx = createContext(req, res, url, hit.route);
      ctx.params = hit.params;
      pipeline.run(ctx);
      return;
    }

    // 静态资源
    serveStatic(req, res, url.pathname);
  });

  // WS upgrade —— 2026-10 安全评审 P0-2：以前任何调用方可直接把 socket
  // 桥到上游。现在握手先过平台认证；浏览器请求（带 Origin）必须同源。
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.origin && !isSameOriginBrowserRequest(req)) {
      rejectUpgrade(socket, 403);
      return;
    }
    const extracted = extractToken(req);
    const auth = deps.identity && deps.identity.authenticate(extracted.token);
    if (!auth) { rejectUpgrade(socket, 401); return; }
    /**
     * 桥处理器**每次现取**（0.21.3）。
     *
     * 内核现在可热切换（保存接入配置即刻生效），而启动时抓一次的话，换到另一个内核
     * 之后这条 WS 还会桥到那个已经不该再用的上游 —— 表现为"界面显示的接入地址是新的，
     * 但实时流仍从旧地址来"。现取没有副作用：`createWsBridge` 每次调用只是返回
     * 一个纯 handler（仅捕获 client），真正的连接在握手时才建。
     */
    const upgradeHandler = deps.kernel.createUpgradeHandler();
    if (!upgradeHandler) { rejectUpgrade(socket, 502); return; }
    try {
      deps.governance.audit.append({
        tenantId: auth.orgId,
        userId: auth.user ? auth.user.id : null,
        action: 'upstream.ws.connect',
        resourceType: 'upstream',
        resourceId: req.url,
        result: 'ok',
        detail: { path: req.url, authVia: extracted.via },
      });
    } catch { /* 审计失败不阻塞桥接 */ }
    upgradeHandler(req, socket, head);
  });

  // 客户端畸形请求不要打挂进程
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    log.debug('clientError: ' + err.message);
  });

  return { server, router, pipeline, plannedRouteCount: PLANNED_ROUTES.length };
}
