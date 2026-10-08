/**
 * 上游产品名的**唯一集中处**与运行期抹名函数。
 *
 * 为什么单独一个文件、而不是塞在 client.mjs 或 index.mjs 里：
 *   · 它要被 **client.mjs**（上游回的错误体会带名字）和 **契约层 app/kernel/index.mjs**
 *     （兜底抹一遍）同时使用；放 client.mjs 会让契约层为了一个字符串函数去依赖 client；
 *     而放 index.mjs 会让 client.mjs 反向 import 回来 —— **循环依赖**。
 *   · 单独一处还有一个好处：全项目"上游叫什么"这件事**只有一个文件知道**，
 *     升级/换上游时的改动面是可枚举的。
 *
 * ── 为什么静态审计不够（真机验收发现的缺陷）────────────────────────────
 *   `tools/audit-layering.mjs` 是**源码静态扫描**：它只能看见"某个文件里有没有写上游名"。
 *   但上游名会随**运行期字符串**穿过契约层落到用户屏幕上 —— 实测：接入向导里填一个
 *   普通 Web 服务的地址，页面显示「该地址有响应，但不像是 DSH（HTTP 200 …）」。
 *   那句话的**字面**写在 dsh-provider 里（审计的豁免范围内），所以审计一路全绿，
 *   而用户眼前赫然是上游产品名。**静态扫描看不见运行时**，所以必须另有一道运行期防线。
 *
 * ── 三道防线各管一段，缺一不可 ──────────────────────────────────────
 *   ① 源码层：audit-layering —— 产品层（app/platform、app/http、public）不许写上游名；
 *   ② 设计层：provider 只报**事实**（HTTP 状态码 / Server / Content-Type），
 *      给人看的散文由产品层（`kernel/connection-config.mjs` 的词表）自己拼 ——
 *      从根上就不产生带名的句子，比事后替换可靠；
 *   ③ 运行期（本函数）：兜住**我们控制不了**的文本 —— 上游回的错误体、上游抛的异常消息。
 *      它替换成中性词"内核"，并收掉抹名后残留在中文里的空格（`不像是 内核` → `不像是内核`）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */

/** 上游产品名（含常见大小写形态）。全项目只此一处。 */
export const UPSTREAM_BRAND_TOKENS = ['DeepSeek Harness', 'DeepSeek', 'DSH'];

/**
 * 把上游产品名从任意文本里抹掉。**幂等**：抹过一遍的文本再抹不会有任何变化。
 * @param {string} text
 * @returns {string}
 */
export function neutralizeUpstreamText(text) {
  const s = String(text == null ? '' : text);
  if (!s) return s;
  let out = s;
  for (const t of UPSTREAM_BRAND_TOKENS) {
    out = out.replace(new RegExp('\\b' + t + '\\b', 'gi'), '内核');
  }
  // 抹名后中文里会剩一个孤零零的空格（"不像是 内核"）—— 收掉它，但不碰中英之间的必要空格。
  return out.replace(/([\u4e00-\u9fff，。：；、（）])\s+(?=[\u4e00-\u9fff])/g, '$1');
}

export default { UPSTREAM_BRAND_TOKENS, neutralizeUpstreamText };
