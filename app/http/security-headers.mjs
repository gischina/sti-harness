/**
 * 安全响应头（P0-D 第 7 项）。
 *
 * 为什么集中在一个纯函数里：
 *   1. 头必须**在写第一个字节之前**设好（`writeHead` 之后再设会抛）。放在请求入口
 *      一次性 `setHeader`，比散落在各 handler 里可靠 —— 没人能"忘了加"。
 *   2. 纯函数 `securityHeaders()` 让回归能直接断言"设了哪些、值是什么"，
 *      不必真起服务看响应头。
 *
 * ⚠️ 诚实说明两个取舍（不要以为设了头就"安全了"）：
 *   · **`script-src` 已不含 `'unsafe-inline'`**（P1-3 / 3.4）：前端原先满屏内联事件属性
 *     （`onclick=...`）与一段首屏内联脚本，逼得 `script-src` 必须放开 `'unsafe-inline'`；
 *     现全部改成**事件委托**（`data-act` / `data-change` / `data-nav`）+
 *     **外链首屏脚本**（`public/boot.js`）。于是 `script-src` 收到 `'self'`，
 *     "往页面里塞一段 `<script>` 或 `onclick` 就能执行"这条 XSS 主路径被堵上。
 *     如实标注：这只消掉了**内联脚本**这一类，不是"前端变安全了"。
 *   · **`style-src` 仍保留 `'unsafe-inline'`**：页面里还有 123 处 `style="..."` 内联样式属性，
 *     且 CSP 里内联样式**属性**同样受 `style-src` 管辖。内联样式能造成的危害
 *     （CSS 注入、布局破坏）与内联脚本不在一个量级，为它做一次 123 处的高风险改写
 *     性价比很低 —— 所以**明确保留并在此写明**，不假装已经去干净。
 *     **但这个数字不再只是注释里的一句话**：`test-frontend` 已把当前计数**冻成断言**
 *     （`护栏：内联 style="..." 属性不得再增长`）—— 新增一处就必须改基线，改基线会被看见。
 *     （3.4 交付时是 122 处，3.6 加 `＋附件` 的隐藏 input 时变成 123，当时没被发现。）
 *   · **HSTS 只在 HTTPS 下发**：明文 HTTP 上发 HSTS 不仅无效（浏览器要求经 TLS 收到
 *     才记），还会给人"我上了 TLS"的错觉。因此本函数按 `secure` 决定发不发。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */

/** 内容安全策略。所有资源均同源；内联样式属性的保留理由见文件头说明。 */
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join('; ');

/** 请求是否经 HTTPS（含反代场景的 x-forwarded-proto），与 cookie 的 Secure 判定同源。 */
export function isHttps(req) {
  const h = (req && req.headers) || {};
  if (String(h['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  const sock = (req && req.socket) || {};
  return !!(sock.encrypted || (sock.socket && sock.socket.encrypted));
}

/**
 * 计算要下发的一组安全头。
 * @param {{secure?:boolean}} [opts] secure=true 时才发 HSTS
 * @returns {Record<string,string>}
 */
export function securityHeaders({ secure = false } = {}) {
  const h = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': CSP,
  };
  if (secure) h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

/** 在请求入口调用（写任何响应之前）。 */
export function applySecurityHeaders(req, res) {
  const h = securityHeaders({ secure: isHttps(req) });
  for (const k of Object.keys(h)) res.setHeader(k, h[k]);
}
