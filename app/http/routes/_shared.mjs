/**
 * 路由层横切件 —— 每条路由都要用的两件事，抽成**单点**。
 *
 * 为什么必须抽（历史体检 assessment-0.11.0 §A1-#1/#2）：
 *   项目自己的分层纪律写着「路由只做解析 → 调 service → 响应」，而 `audit`（留痕）与
 *   `unwrap`（service 结果 → HTTP 语义）恰恰是**每条路由都要用的横切件** ——
 *   它们散在 `model.mjs` / `notify.mjs` / `schedule.mjs` 三份逐字拷贝里，正好违背这条纪律。
 *   三份拷贝的差异只有 `resourceType` 一个字串，改一处忘一处就是永久漂移。
 *
 * 本文件**不是**路由模块：它不导出任何 `*Routes(deps)`，`index.mjs` 也不会装配它。
 * 放在 `routes/` 下只是因为它是"路由层"的东西，跟同层其它文件放一起最好找。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { validateBody } from '../../util/validate.mjs';
import { errors } from '../../util/errors.mjs';

/**
 * 按声明式 schema 校验 JSON 请求体（校验器见 app/util/validate.mjs）。
 *
 * 失败直接**抛** 400 `bad_request`（`detail.fields` 给逐字段原因）——
 * 与 OpenAPI「参数不对回 400」的既有约定一致；不用返回值是因为
 * 调用方不需要再写 `if (!ok) return;`，统一错误出口会接住这个 throw。
 *
 * @param {Record<string, object>} schema 字段声明
 * @param {unknown} body 已解析的请求体
 */
export function requireBody(schema, body) {
  const r = validateBody(schema, body);
  if (!r.ok) throw errors.badRequest('入参校验失败', { fields: r.errors });
}

/**
 * 造一个审计留痕函数，`resourceType` 由调用方注入（`'model'` / `'notify'` / `'schedule'` ……）。
 *
 * 语义与三处原实现**逐字一致**：
 *   · 治理服务未装配（`governance` 为空）也不阻塞主流程，只是少一条留痕；
 *   · 留痕本身抛错也吞掉 —— **留痕失败不该改变业务结果**。
 *
 * @param {string} resourceType 资源类型标签（写进审计记录的 `resourceType`）
 * @param {{audit?:{append:(e:object)=>void}}|null} governance 治理服务（可空）
 * @returns {(ctx:any, action:string, resourceId:unknown, result:string, detail?:object|null)=>void}
 */
export function auditOf(resourceType, governance) {
  return function audit(ctx, action, resourceId, result, detail) {
    try {
      if (governance && governance.audit) {
        governance.audit.append({
          tenantId: ctx.tenantId, userId: ctx.userId || null,
          action, resourceType, resourceId: String(resourceId || ''),
          result, detail: detail || null,
        });
      }
    } catch { /* 留痕失败不影响业务结果 */ }
  };
}

/**
 * 把 service 的 `{ok:false, error|reason}` 翻成 HTTP 语义 —— 统一一处，避免每条路由各写一遍。
 *
 * 两条映射（三处原实现逐字相同）：
 *   · `reason === 'not_found'` → 404 + `not_found`；
 *   · 其余 → 400 + `bad_request`（错误文案缺省为「请求无法处理」）。
 *
 * @param {any} ctx 请求上下文（提供 `fail(status, code, message)`）
 * @param {{ok?:boolean, reason?:string, error?:string}|null} r service 返回值
 * @returns {boolean} `true` 表示成功（调用方继续正常响应）；`false` 表示已写回错误响应
 */
export function unwrap(ctx, r) {
  if (r && r.ok) return true;
  if (r && r.reason === 'not_found') { ctx.fail(404, 'not_found', r.error); return false; }
  ctx.fail(400, 'bad_request', (r && r.error) || '请求无法处理');
  return false;
}
