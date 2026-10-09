/**
 * 传输层：HTTP 反代 + WebSocket 双工桥（零依赖）。
 *
 * WS 桥为什么不需要任何库：**这个桥本来就是透明字节管道**——
 * 浏览器发出的帧已按客户端规则掩码，上游作为服务端需要的正是掩码帧；
 * 上游回的帧未掩码，浏览器作为客户端需要的也正是不带掩码的帧。
 * 所以中间既不解帧、也不重新编码，只要「两侧握手都做对，然后双向 pipe 原始字节」。
 * （这套实现从基线实现迁移而来，已在真实环境跑通。）
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { log } from '../../log.mjs';
import { errors } from '../../util/errors.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsAccept = (key) => crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

const MAX_BODY = 2 * 1024 * 1024;

/**
 * 把浏览器请求转发到上游 DSH 主机。带会话 cookie，401 时重换一次令牌再试。
 * @returns {Promise<void>}
 */
export async function forwardHttp(req, res, { client, pathname, search = '' }) {
  await client.ensureAuth(false);
  const target = client.origin + pathname + (search || '');

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length', 'cookie', 'accept-encoding'].includes(k.toLowerCase()) && k.toLowerCase() !== 'accept-encoding') continue;
    headers[k] = v;
  }
  // 不转发浏览器自己的 cookie（那是本平台的会话），只带上游 DSH 的
  const cookie = client.cookie;
  if (cookie) headers.cookie = cookie;

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw errors.badRequest('请求体过大（上限 ' + Math.round(MAX_BODY / 1024) + 'KB）');
      chunks.push(c);
    }
    body = Buffer.concat(chunks);
  }

  const send = () => fetch(target, { method: req.method, headers, body, redirect: 'manual' });
  let up = await send();
  if (up.status === 401 && client.state.token) {
    const again = await client.ensureAuth(true);
    if (again.ok) up = await send();
  }

  const outHeaders = {};
  for (const [k, v] of up.headers.entries()) {
    if (['connection', 'transfer-encoding', 'content-encoding', 'set-cookie'].includes(k.toLowerCase())) continue;
    outHeaders[k] = v;
  }
  res.writeHead(up.status, outHeaders);
  if (req.method === 'HEAD' || !up.body) { res.end(); return; }
  await new Promise((resolve, reject) => {
    const src = Readable.fromWeb(up.body);
    src.on('error', reject);
    src.pipe(res).on('finish', resolve).on('error', reject);
  });
}

/**
 * 生成 HTTP `upgrade` 事件处理器：把 /api/* 的 WebSocket 桥到上游。
 * @param {{client:object, prefixes?:string[]}} opts
 * @returns {(req:import('node:http').IncomingMessage, socket:net.Socket, head:Buffer)=>void}
 */
export function createWsBridge({ client, prefixes = ['/api/'] }) {
  let lastMsg = '';
  let lastAt = 0;
  const throttled = (msg) => {
    const now = Date.now();
    if (msg === lastMsg && now - lastAt < 10000) return;   // 浏览器每 3s 自动重连，避免刷屏
    lastMsg = msg; lastAt = now;
    log.warn('实时流桥接断开：' + msg);
  };

  return function handleUpgrade(req, socket, head) {
    const u = new URL(req.url, 'http://placeholder');
    if (!prefixes.some((p) => u.pathname.startsWith(p))) { socket.destroy(); return; }

    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    let upstream;
    try { upstream = new URL(client.origin); } catch (e) { throttled('上游地址无法解析：' + e.message); socket.destroy(); return; }

    const isTls = upstream.protocol === 'https:';
    const upPort = Number(upstream.port) || (isTls ? 443 : 80);
    const upPrefix = upstream.pathname && upstream.pathname !== '/' ? upstream.pathname.replace(/\/+$/, '') : '';

    const up = isTls
      ? tls.connect({ host: upstream.hostname, port: upPort, servername: upstream.hostname })
      : net.connect({ host: upstream.hostname, port: upPort });
    up.setNoDelay(true);
    socket.setNoDelay(true);

    const upKey = crypto.randomBytes(16).toString('base64');
    let handshaken = false;
    let dead = false;
    let hdrBuf = Buffer.alloc(0);
    let retriedAuth = false;
    const pending = [];
    let clientHead = head && head.length ? head : null;

    const cleanup = () => {
      if (dead) return;
      dead = true;
      try { socket.destroy(); } catch { /* ignore */ }
      try { up.destroy(); } catch { /* ignore */ }
    };
    const fail = (why) => { if (!dead) throttled(why); cleanup(); };

    socket.on('data', (chunk) => {
      if (!handshaken) { pending.push(chunk); return; }
      if (!up.destroyed) up.write(chunk);
    });
    socket.on('error', cleanup);
    socket.on('close', cleanup);
    socket.on('end', cleanup);
    up.on('error', (e) => fail(e.message));
    up.on('close', cleanup);

    up.on('connect', () => {
      const cookie = client.cookie;
      up.write(
        'GET ' + upPrefix + u.pathname + (u.search || '') + ' HTTP/1.1\r\n'
        + 'Host: ' + upstream.host + '\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: ' + upKey + '\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + (cookie ? 'Cookie: ' + cookie + '\r\n' : '')
        + '\r\n'
      );
    });

    /* 只有上游握手校验通过，才回浏览器 101 ——
       这样 DSH 没起来时浏览器直接连接失败（界面显示"实时流断开"），
       而不是先显示"已连接"再悄悄掉线。 */
    up.on('data', (chunk) => {
      if (handshaken) { if (!socket.destroyed) socket.write(chunk); return; }
      hdrBuf = Buffer.concat([hdrBuf, chunk]);
      const end = hdrBuf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (hdrBuf.length > 16384) fail('上游握手响应异常（超过 16KB 仍未结束）');
        return;
      }
      const headText = hdrBuf.subarray(0, end).toString('latin1');
      const rest = hdrBuf.subarray(end + 4);
      if (!/^HTTP\/1\.1 101/.test(headText)) {
        const first = headText.split('\r\n')[0];
        if (/\s(401|403)\s/.test(first) && client.state.token && !retriedAuth) {
          retriedAuth = true;
          client.ensureAuth(true).then((r) => {
            if (r.ok) throttled('上游拒绝了实时流（' + first + '），已重新换取令牌，浏览器重连即可恢复');
            else fail('上游拒绝了实时流且重新认证失败：' + (r.error || first));
          });
          cleanup();
          return;
        }
        fail('上游未同意升级：' + first);
        return;
      }
      if ((headText.match(/sec-websocket-accept:\s*(\S+)/i) || [])[1] !== wsAccept(upKey)) {
        fail('上游 Sec-WebSocket-Accept 校验失败');
        return;
      }

      handshaken = true;
      if (socket.destroyed) { cleanup(); return; }

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
      );
      if (clientHead) { up.write(clientHead); clientHead = null; }
      while (pending.length) up.write(pending.shift());
      if (rest.length) socket.write(rest);
    });
  };
}
