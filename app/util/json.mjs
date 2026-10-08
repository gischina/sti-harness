/**
 * 安全 JSON 解析 —— 一个"解析失败就有兜底"的小工具，**单点**。
 *
 * 为什么需要：数据库里存 JSON 的列（`meta_json` / `params_json` / `detail_json` /
 * `payload_json` ……）在**任何**读取点都可能遇到坏值（手工改库、旧版本写入、磁盘截断）。
 * 每个读取点各写一遍 `try { JSON.parse(x || '{}') } catch { return {} }`，就是一份
 * 逐字重复 —— 历史体检（assessment-0.11.0 §A1-#5）数出 6 份变体，改一处口径要记得改六处。
 *
 * 与 `platform/knowledge/parsers/json.mjs` 的 `parseJson` **不是一回事**，别合并：
 *   · 那个是**文档解析器** —— 要把 JSON 拆成可检索的叶子块，解析失败要**如实抛错**
 *     （带 `code='parse_failed'`），因为"这个文件读不了"必须让用户知道；
 *   · 这个是**落库元信息的读取容错** —— 坏值要**静默兜底**，因为"某条记录的元信息坏了"
 *     不该让整条主流程失败。
 *   两者"失败"的语义相反，强行共用一个函数会把两种意图搅在一起。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */

/**
 * 解析 JSON 字符串；**任何**异常（含空串、`undefined`、语法错误）都退回 `fallback`。
 *
 * 与朴素写法的两处差异（都是**更安全**的方向，历史调用点已逐一核对）：
 *   · `null` / `undefined` 输入：朴素写法 `JSON.parse(x || '{}')` → `{}`；本函数同结果。
 *   · JSON 字面量本身就是 `null`（字符串 `'null'`）：朴素写法可能返回 `null`，
 *     调用方 `meta.foo` 会抛；本函数把 `null` 也归到 `fallback`。
 *
 * @template T
 * @param {unknown} raw 待解析的字符串（也可能已是 `null`/`undefined`）
 * @param {T} [fallback] 失败或解析为 `null` 时的返回（默认空对象）
 * @returns {T}
 */
export function parseJsonSafe(raw, fallback = /** @type {any} */ ({})) {
  try {
    const v = JSON.parse(/** @type {string} */ (raw));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
