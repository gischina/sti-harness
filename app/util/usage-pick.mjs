/**
 * 用量取数规则 —— **全项目单一真源**。
 *
 * ── 为什么必须有这么一个文件（真机验收抓到的漏账）────────────────────────
 *   上游**没有独立的 usage 事件**：用量挂在 `assistant/message` 的 `data.usage` 上
 *   （契约层 `kernel/dsh-provider/events.mjs` 顶部早已写明）。而"记账"这件事曾经有
 *   **两份各自为政的实现**，且**两份都只认 `type === 'usage'`**：
 *     · `app/platform/governance/usage.mjs` 的 `recordFromEvents`（写 usage_records）
 *     · `app/data/repositories/events.mjs` 的 `usageSummary`（工作台面板读它）
 *   于是真内核上每一轮的用量都记 0 —— 成本报表是空的、工作台显示"累计 tokens 0"。
 *   fixtures 与测试替身恰好会发独立的 usage 事件，所以回归一路是绿的
 *   （**桩数据形状与真实形状漂移**的又一例，也是最贵的一例：整条归因链路空转）。
 *
 *   修的时候顺手把"两份实现"合成一份：**同一个数字被两处各算一遍，迟早会算出两个数**。
 *
 * ── 规则 ────────────────────────────────────────────────────────────
 *   ① **任何带 `usage` 对象的记录都算**（不再要求 `type === 'usage'`）；
 *   ② 同一轮里**有独立 usage 事件时只认它** —— 助手消息与独立事件可能带的是同一组数字，
 *      两个都算就是**把一笔账记两遍**（比漏账更难发现：总数看着还挺合理）；
 *   ③ 缺数字就是缺（`usage` 不是对象 → 直接跳过，**绝不补 0 也绝不猜**）。
 *
 * 与上层无关：这里不认识 HTTP、不认识 SQL、不认识上游 —— 只做"从记录里挑出该计账的那几条"。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */

/**
 * 从一组记录里挑出**该计账的 usage**。
 * @param {Array<{turnId?:string|null, type?:string, usage?:object}>} records
 * @returns {Array<object>} 该计账的 usage 对象数组（顺序不保证）
 */
export function pickUsageEntries(records) {
  if (!Array.isArray(records)) return [];
  /** turn 键 → { explicit, attached }；没有 turnId 的一律归到同一个键下（求和结果不受影响） */
  const groups = new Map();
  for (const r of records) {
    if (!r || !r.usage || typeof r.usage !== 'object') continue;
    const key = r.turnId == null ? '' : String(r.turnId);
    let g = groups.get(key);
    if (!g) { g = { explicit: [], attached: [] }; groups.set(key, g); }
    (r.type === 'usage' ? g.explicit : g.attached).push(r.usage);
  }
  const out = [];
  for (const g of groups.values()) {
    const picked = g.explicit.length ? g.explicit : g.attached;
    for (const u of picked) out.push(u);
  }
  return out;
}

export default { pickUsageEntries };
