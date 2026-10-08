/**
 * 请求网络信息解析 —— 客户端 IP 与"是否 HTTPS"判定的**唯一出处**。
 *
 * 为什么需要一个显式的 trustProxy 开关（2026-10 评审 P1-9）：
 *   · 直连形态下，真实来源就是 socket 地址；
 *   · 经反向代理部署时，socket 地址永远是代理自身 —— 所有外部用户共用一个 IP，
 *     按 IP 的限流会误伤全体，真实来源只能从 `X-Forwarded-For` 读，
 *     原始协议只能从 `X-Forwarded-Proto` 读；
 *   · 但这两个头**客户端可随意伪造**。所以默认一律不采信，
 *     只有部署者确认"前面确实有自己配的反代"并显式打开 trustProxy 时才读。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */

/** 去掉 IPv6 zone id（fe80::1%eth0），并把 IPv4-mapped 地址（::ffff:1.2.3.4）还原成 IPv4 */
function normalize(raw) {
  let s = String(raw || '').split('%')[0];
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}

/**
 * 请求是否走的安全通道。
 * 直连看 socket.encrypted；trustProxy 时额外采信 X-Forwarded-Proto 的**首个**值。
 * @param {import('node:http').IncomingMessage} req
 * @param {{trustProxy?:boolean}} [opts]
 * @returns {boolean}
 */
export function isSecureRequest(req, { trustProxy = false } = {}) {
  if (req.socket && req.socket.encrypted) return true;
  if (trustProxy) {
    const proto = req.headers['x-forwarded-proto'];
    if (typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https') return true;
  }
  return false;
}

/**
 * 取客户端 IP。
 * trustProxy 时优先取 X-Forwarded-For 的**最左**地址（最初的客户端；
 * 后续跳由代理追加），无法解析再回落 socket。
 * @param {import('node:http').IncomingMessage} req
 * @param {{trustProxy?:boolean}} [opts]
 * @returns {string}
 */
export function clientIpOf(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string') {
      const first = xf.split(',')[0].trim();
      if (first) return normalize(first);
    }
  }
  const sock = req.socket && req.socket.remoteAddress;
  return sock ? normalize(sock) : 'unknown';
}
