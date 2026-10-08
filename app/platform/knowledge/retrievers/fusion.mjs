/**
 * RRF（Reciprocal Rank Fusion）融合。
 *
 * 为什么用 RRF 而不是加权求和：
 *   bm25 的分数是**无界的负数**（越小越相关），余弦相似度是 **-1..1**。
 *   把这两个量纲不同的分数直接加权重，权重就没法凭直觉解释了 ——
 *   换个语料就得重调，而且调出来的值只能靠试。
 *   RRF 只看**排名**：`score = Σ 1/(k + rank)`，天然免去了分数标定，
 *   这也是它在工业界被广泛默认采用的原因。
 *
 * `k=60` 是 RRF 原论文的取值，作用是压平头部：让「第 1 名 vs 第 2 名」的差距
 *   不至于过大，避免单一列表主导结果。
 *
 * 这一步是**纯函数**：输入若干「已排好序的列表」，输出合并后的顺序。
 * 因此可以被穷举测试，不需要数据库。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */

export const DEFAULT_RRF_K = 60;

/**
 * @param {Array<{name:string, weight?:number, items:Array<{chunkId:number}>}>} lists
 * @param {{k?:number, limit?:number}} [opts]
 * @returns {{items:Array, k:number, listSizes:object, contributions:object}}
 */
export function reciprocalRankFusion(lists, opts = {}) {
  const k = Number(opts.k) > 0 ? Number(opts.k) : DEFAULT_RRF_K;
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 0;

  const merged = new Map();
  const listSizes = {};

  for (const list of (lists || [])) {
    const name = list && list.name ? list.name : 'list';
    const weight = list && Number.isFinite(list.weight) ? Number(list.weight) : 1;
    const items = (list && Array.isArray(list.items)) ? list.items : [];
    listSizes[name] = items.length;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || it.chunkId == null) continue;
      const rank = i + 1;
      const add = weight / (k + rank);
      const cur = merged.get(it.chunkId);
      if (cur) {
        cur.rrf += add;
        cur.best = cur.best || it;
        cur.contributions[name] = { rank, weight, score: it.score != null ? it.score : null, add };
        // 若该条在向量列表里出现，用它的余弦分做展示（更直观）
        if (name === 'vector' && it.score != null) cur.vectorScore = it.score;
        if (name === 'fts' && it.score != null) cur.ftsScore = it.score;
      } else {
        merged.set(it.chunkId, {
          ...it,
          rrf: add,
          best: it,
          contributions: { [name]: { rank, weight, score: it.score != null ? it.score : null, add } },
          ftsScore: name === 'fts' && it.score != null ? it.score : null,
          vectorScore: name === 'vector' && it.score != null ? it.score : null,
        });
      }
    }
  }

  const items = [...merged.values()].sort((a, b) => {
    if (b.rrf !== a.rrf) return b.rrf - a.rrf;
    // 平局时给一个稳定的次序，避免同一查询两次结果顺序飘移（回归测试才有意义）
    return a.chunkId - b.chunkId;
  });

  return {
    items: limit ? items.slice(0, limit) : items,
    k,
    listSizes,
  };
}

/** 把 RRF 分归一化到 0..1，仅用于展示（不参与排序） */
export function normalizeRrfScores(items) {
  if (!items.length) return items;
  const max = items[0].rrf || 1;
  return items.map((it) => ({ ...it, rrfNormalized: Number((it.rrf / max).toFixed(6)) }));
}
