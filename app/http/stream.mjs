/**
 * NDJSON 流式输出助手 —— 零依赖的"一条一行"增量响应。
 *
 * 为什么不用 WebSocket / SSE：
 *   · WebSocket：Node 内置 `http` 没有服务端 WS，自己实现握手与帧协议是几百行
 *     且容易出错；本项目的实时流需求是**单向的**（服务端 → 浏览器），WS 的双工
 *     能力用不上。已有的 `/api/* upgrade → 上游` 只是**透明字节管道**，不是我们
 *     自己的 WS 服务端，不能复用。
 *   · EventSource(SSE)：只支持 GET，而"提交一轮对话"必须有请求体（POST）。
 *     绕过办法（先 POST 拿 id 再 GET 流）会引入两个接口与一个中间态，得不偿失。
 *
 * 因此选 **POST + 分块响应**：请求体照常带，响应体一行一个 JSON 对象。
 * 浏览器侧用 `fetch()` 拿到 `response.body` 的 `ReadableStream`，逐块解码、
 * 按 `\n` 切行 —— 首字即达，不必等整轮收完。协议见 docs/architecture.md。
 *
 * 帧格式（每行一个 JSON，字段 `kind` 决定类型）：
 *   meta    —— 流建立（会话、内核会话、开始时间）
 *   turn    —— 上游已受理本轮（turnId）
 *   event   —— 一条归一化事件（`event` 字段是完整事件对象）
 *   warning —— 非致命异常（如收集超时截断），如实转达
 *   done    —— 本轮结束（落库条数、用量、产物、耗时）
 *   error   —— 致命错误（此时 HTTP 状态无法再改，客户端只认这一帧）
 *   ping    —— 心跳（防代理断空闲连接；客户端应忽略）
 *
 * ⚠️ 一旦 `open()` 写出 200 响应头，**此后无法再改 HTTP 状态码**。
 * 所以调用方必须把"可能失败且希望回 4xx"的步骤（会话校验、上游受理）放在
 * `open()` 之前；`open()` 之后的失败只能走 `error` 帧。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */

/** 默认心跳间隔（毫秒）：大于多数反向代理的 60s 空闲超时的一半即可 */
const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * @param {object} ctx 请求上下文（http/context.mjs）
 * @param {{heartbeatMs?:number}} [opts]
 */
export function openNdjsonStream(ctx, opts = {}) {
  const res = ctx.res;
  if (res.headersSent) throw new Error('响应已开始写出，无法切换为流式');

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-request-id': ctx.requestId,
    // 关掉 nginx 的响应缓冲：否则增量帧会被攒成一大块，流式退化成"整轮返回"
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });
  ctx.headersSent = true;

  // 关掉 Nagle：否则小帧会被攒起来合并发送，"增量到达"在客户端看起来仍是"一次到齐"。
  try { if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true); } catch { /* 某些代理场景下不可设置 */ }

  let closed = false;
  const heartbeatMs = Number(opts.heartbeatMs || DEFAULT_HEARTBEAT_MS);

  // 客户端断开（关页面/断网）：标记 closed，之后所有 write 变空操作。
  // 注意：这里**不**终止业务逻辑 —— 轮次仍应落库，只是不再往死连接写字节。
  const onClose = () => { closed = true; };
  res.on('close', onClose);

  const timer = heartbeatMs > 0
    ? setInterval(() => { write({ kind: 'ping', ts: Date.now() }); }, heartbeatMs)
    : null;
  timer && timer.unref && timer.unref();

  /** 写一帧。返回 false 表示连接已关或写失败（调用方据此可提前收手）。 */
  function write(obj) {
    if (closed || res.writableEnded || res.destroyed) return false;
    try {
      // 末尾换行 = 帧分隔符。JSON.stringify 不会产出裸换行（字符串内的 \n 会被转义）。
      return res.write(JSON.stringify(obj) + '\n');
    } catch {
      closed = true;
      return false;
    }
  }

  /** 收尾：清心跳、结束响应。可重复调用。 */
  function close() {
    if (timer) clearInterval(timer);
    res.removeListener('close', onClose);
    if (!res.writableEnded && !res.destroyed) {
      try { res.end(); } catch { /* 已断开则忽略 */ }
    }
    closed = true;
  }

  return {
    write,
    close,
    get closed() { return closed || res.destroyed; },
    meta: (o) => write({ kind: 'meta', ts: Date.now(), ...o }),
    turn: (o) => write({ kind: 'turn', ts: Date.now(), ...o }),
    event: (ev) => write({ kind: 'event', event: ev }),
    warning: (message, extra = {}) => write({ kind: 'warning', message, ...extra }),
    done: (o) => write({ kind: 'done', ts: Date.now(), ...o }),
    error: (code, message, extra = {}) => write({ kind: 'error', code, message, ...extra }),
  };
}
