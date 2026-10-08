/**
 * 模型目录 provider 推导 —— 上游组缺 provider 时，按模型 id 的命名空间前缀补齐。
 *
 * 为什么敢这样推：模型 id 带命名空间是这条上游的真实事实（如
 * `deepseek-official/deepseek-flash`），对同一上游的基线实现也这么取 —
 * 前缀就是 provider，不是猜的。推导只在**组内全部带前缀的模型同属一个
 * 命名空间**时成立；出现两个及以上不同前缀（或一个前缀都没有）时返回空，
 * 交给上层如实显示「未知来源」。
 *
 * 诚实原则同 index.mjs：补得上才补，补不上就说补不上，绝不编一个。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */

/**
 * 从一组模型 id 推导 provider。
 * @param {Array<{id:string}>} models 组内模型清单
 * @returns {string} 唯一命名空间；推导不成立时返回 ''
 */
export function inferGroupProvider(models) {
  const list = Array.isArray(models) ? models : [];
  const ns = new Set();
  for (const m of list) {
    const id = String((m && m.id) || '');
    const i = id.indexOf('/');
    if (i <= 0) continue;           // 无前缀或空前缀（'/x'）都不构成证据
    ns.add(id.slice(0, i));
  }
  return ns.size === 1 ? [...ns][0] : '';
}

/**
 * 给缺 provider 的组补上推导值；已有 provider 的组原样保留。
 * 不改传入对象（补全时返回新组对象）。
 * @param {Array} groups 上游模型目录组
 * @returns {Array} 补全后的组
 */
export function fillGroupProviders(groups) {
  const list = Array.isArray(groups) ? groups : [];
  return list.map((g) => {
    if (!g || g.provider) return g;
    const inferred = inferGroupProvider(g.models);
    return inferred ? { ...g, provider: inferred } : g;
  });
}
