/**
 * 统一错误类型。
 *
 * 纪律：错误必须**自带 HTTP 状态语义**，这样路由层不需要给每个 handler
 * 写 try/catch 决定回 400 还是 500。回给前端的 body 里只放 code + message 摘要，
 * 堆栈只进服务端日志（不泄漏内部结构）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
export class AppError extends Error {
  constructor(code, message, httpStatus = 400, detail) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

export const errors = {
  badRequest: (msg, detail) => new AppError('bad_request', msg || '请求参数有误', 400, detail),
  unauthorized: (msg) => new AppError('unauthorized', msg || '未登录或会话已过期', 401),
  forbidden: (msg) => new AppError('forbidden', msg || '没有权限执行该操作', 403),
  notFound: (msg) => new AppError('not_found', msg || '资源不存在', 404),
  conflict: (msg) => new AppError('conflict', msg || '资源状态冲突', 409),
  quota: (msg) => new AppError('quota_exceeded', msg || '已超出配额', 429),
  upstream: (msg, detail) => new AppError('upstream_error', msg || '上游服务异常', 502, detail),
  degraded: (msg, detail) => new AppError('capability_degraded', msg || '该能力当前不可用', 503, detail),
  internal: (msg) => new AppError('internal_error', msg || '服务内部错误', 500),
};

/** 把任意 throw 出来的东西收敛成 { httpStatus, code, message } */
export function toHttpError(e) {
  if (e instanceof AppError) {
    return { httpStatus: e.httpStatus, code: e.code, message: e.message, detail: e.detail };
  }
  // 非 AppError 但**自带 HTTP 语义**的（如 context.mjs 的请求体读取器：413 超限 / 400 坏 JSON）。
  // 这里必须认它们：否则一个"文件太大"会在响应里变成 500 internal_error，
  // 调用方看到的是"服务器坏了"，而真实原因（该传小一点）一个字都看不到。
  // 这是一条真实缺陷：读体函数从 M0 起就抛 `{code,httpStatus}` 的普通 Error，
  // 而这里只认 AppError —— 直到附件上传把 413 这条路第一次真正走到，才暴露出来。
  if (e && Number.isFinite(Number(e.httpStatus)) && Number(e.httpStatus) >= 400 && e.code) {
    return { httpStatus: Number(e.httpStatus), code: String(e.code), message: e && e.message ? String(e.message) : String(e.code) };
  }
  return { httpStatus: 500, code: 'internal_error', message: e && e.message ? String(e.message) : '未知错误' };
}
