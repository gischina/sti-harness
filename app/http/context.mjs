/**
 * 请求上下文 —— 每个请求一个，贯穿整条中间件链与 handler。
 *
 * 它同时是「响应助手」：handler 只调 ctx.json() / ctx.text()，
 * 不直接碰 res.writeHead —— 这样错误收敛、审计收尾、统一响应头都有一个挂钩点。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import crypto from 'node:crypto';
import { toHttpError } from '../util/errors.mjs';
import { log } from '../log.mjs';

export function createContext(req, res, url, route) {
  const requestId = 'req_' + crypto.randomBytes(6).toString('hex');
  const ctx = {
    req, res, url, route,
    requestId,
    params: {},
    startedAt: Date.now(),
    /** 中间件把结果记在这里，状态页与审计据此了解"这条链上发生了什么" */
    chain: [],
    middleware: {},           // 名称 → 'ok' | 'pass-through' | 'skip' | 'denied'
    user: null,
    tenantId: null,
    /** 治理拦截留痕用（M3）：被拒绝也要写审计 */
    deniedReason: null,
    query: Object.fromEntries(url.searchParams.entries()),
    headersSent: false,
    log: (...a) => log.info('[' + requestId + ']', ...a),

    setHeader(k, v) { if (!res.headersSent) res.setHeader(k, v); return ctx; },

    json(status, body, headers = {}) {
      if (res.headersSent) return;
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-request-id': requestId,
        ...headers,
      });
      ctx.headersSent = true;
      res.end(payload);
    },

    ok(body = {}) { ctx.json(200, { ok: true, ...body }); },
    fail(status, code, message, detail) {
      ctx.json(status, { ok: false, error: { code, message, ...(detail ? { detail } : {}) } });
    },
    text(status, body, contentType = 'text/plain; charset=utf-8') {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'x-request-id': requestId });
      ctx.headersSent = true;
      res.end(body);
    },
    noContent(status = 204) {
      if (res.headersSent) return;
      res.writeHead(status, { 'x-request-id': requestId });
      ctx.headersSent = true;
      res.end();
    },

    /** 统一错误出口：任何层抛出来的东西都从这里变成响应 + 一条服务端日志 */
    handleError(e) {
      const { httpStatus, code, message, detail } = toHttpError(e);
      // 限流/退避类错误带上 `Retry-After`（标准头，比塞进 body 更通用）——
      // 客户端与反向代理都能直接读它，而不必解析错误文案里的秒数。
      const retryMs = detail ? Number(detail.retryAfterMs) : NaN;
      if (Number.isFinite(retryMs) && retryMs > 0) {
        ctx.setHeader('retry-after', String(Math.ceil(retryMs / 1000)));
      }
      const elapsed = Date.now() - ctx.startedAt;
      if (httpStatus >= 500) {
        log.error('[' + requestId + '] ' + req.method + ' ' + url.pathname + ' → ' + httpStatus + ' ' + code + '：' + message);
        if (e && e.stack) log.debug(e.stack);
      } else {
        log.debug('[' + requestId + '] ' + req.method + ' ' + url.pathname + ' → ' + httpStatus + ' ' + code + '：' + message);
      }
      // `detail` 必须与 ctx.fail 同形状地带上：入参校验的逐字段原因（detail.fields）
      // 是「参数不对回 400」契约的一部分（见 openapi.mjs），丢掉它调用方只看到
      // 干巴巴一句「入参校验失败」，等于把"错在哪"藏了起来。
      ctx.json(httpStatus, { ok: false, error: { code, message, ...(detail ? { detail } : {}) }, requestId, elapsedMs: elapsed });
    },
  };
  return ctx;
}

/** 读取 JSON 请求体（带大小上限，避免一个请求打爆内存） */
export async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      const e = new Error('请求体过大（上限 ' + Math.round(limit / 1024) + 'KB）');
      e.code = 'bad_request';
      e.httpStatus = 413;
      throw e;
    }
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch {
    const e = new Error('请求体不是合法 JSON');
    e.code = 'bad_request';
    e.httpStatus = 400;
    throw e;
  }
}

/**
 * 读取**原始字节**请求体（文件上传用）。
 *
 * 为什么不做 multipart：multipart/form-data 的解析要自己处理 boundary、
 * 嵌套的 header、CRLF 折行与 base64 变体 —— 手写一个"差不多能用"的解析器，
 * 出错方式是**静默地把文件截断或错位**，比不支持更糟。这里的契约简单到不会错：
 * 元数据走 query（`?filename=`），body 就是文件本身。前端用 `fetch(url,{body:file})`
 * 一行即可（File 本身就是 Blob）。
 *
 * 超限**抛出 413** 而不是截断 —— 静默截断会让用户拿到一个"能下载但内容不全"的文件。
 */
export async function readRawBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      const e = new Error('文件过大（上限 ' + Math.round(limit / 1024 / 1024) + 'MB）');
      e.code = 'bad_request';
      e.httpStatus = 413;
      throw e;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

