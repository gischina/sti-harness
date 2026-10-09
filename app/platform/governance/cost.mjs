/**
 * 成本核算（token → 金额）—— P1-3 / 4.4。
 *
 * 这条能力最容易做成"看起来对"的东西，所以先把**三条不允许违反的规则**写在最前面：
 *
 *  1. **没配单价就是"不知道"，不是 0 元。**
 *     0 元表示"免费"。把"不知道"当 0 会算出一个偏低的、看起来完全正常的总额 ——
 *     这正是本项目最不能接受的一类错误（README §3 诚实数据源）。
 *     因此未定价的 token 单独成桶返回，`amountMinor` 为 `null` 而不是 0。
 *
 *  2. **缓存价不许用输入价顶替。**
 *     `cache_read` 通常比 `input` 便宜得多（常见是 1/10），`cache_write` 通常更贵。
 *     拿 input 价去乘缓存 token 会得到一个**系统性偏离**的数，而且偏离方向取决于用量结构，
 *     外人无从判断对错。所以缓存没配价 → 那部分 token 记为"未定价"。
 *
 *  3. **单价不追溯。** 单价是当下的配置。把它套到三个月前的用量上是编造历史，
 *     所以口径必须写成"按当前单价估算"，且 `pricedAsOf` 语义是"读配置的时刻"。
 *
 * 另外两条口径（来自契约层，别在别处重新定义）：
 *   · 计费输入 = `input` + `cache_read` + `cache_write`（`input` 的语义是"未缓存输入"）；
 *   · `reasoning` 是 `output` 的**子集**，不另计（`contract.mjs` 顶部注释）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { all } from '../../data/db.mjs';

/** 四类 token 与它们各自的单价列 —— 顺序固定，输出可快照 */
export const TOKEN_CLASSES = [
  { key: 'input', label: '未缓存输入', column: 'input', priceField: 'priceInMinor' },
  { key: 'cacheRead', label: '缓存读取', column: 'cache_read', priceField: 'priceCacheReadMinor' },
  { key: 'cacheWrite', label: '缓存写入', column: 'cache_write', priceField: 'priceCacheWriteMinor' },
  { key: 'output', label: '输出', column: 'output', priceField: 'priceOutMinor' },
];

export const PRICE_FIELDS = TOKEN_CLASSES.map((c) => c.priceField);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 这一行代表**多少条**用量记录。
 *
 * `buildCostReport` 同时接受两种输入：原始用量行（一行 = 一条记录，没有 `usageRows` 字段）
 * 与 `summarizeCost` 的 `GROUP BY model_id` 聚合行（一行 = 一组，带 `COUNT(*) AS usageRows`）。
 * 不区分这两者，聚合输入下"N 行用量"会恒显示 1 —— 页面上就成了"每个模型只有一条记录"，
 * 而真实情况是几万条。数字错得不明显，但错得彻底。
 */
function rowsOf(r) {
  const n = Number(r && r.usageRows);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/** 单价是否可用：必须是**非负整数或 null**。负数、小数、NaN 一律当"没配"（宁可不算，不可算错）。 */
function priceOf(price, field) {
  if (!price) return null;
  const v = price[field];
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

/** 最小货币单位 → 人类可读金额（两位小数；**不用浮点累加**，只在最后一步除一次） */
export function formatAmount(amountMinor, currency) {
  if (amountMinor === null || amountMinor === undefined) return null;
  const neg = amountMinor < 0;
  const abs = Math.abs(Number(amountMinor));
  const unit = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return (neg ? '-' : '') + (currency ? currency + ' ' : '') + unit + '.' + frac;
}

/**
 * 算一个模型条目的金额。**纯函数**。
 *
 * @param {{tokens:object, price:object|null}} args
 *   `tokens` = `{input, cacheRead, cacheWrite, output}`（数字，缺项按 0）
 *   `price`  = `{currency, priceInMinor, priceCacheReadMinor, priceCacheWriteMinor, priceOutMinor}` 或 null
 * @returns {{currency:string, amountMinor:number|null, amount:string|null,
 *            pricedTokens:number, unpricedTokens:number, partial:boolean,
 *            classes:Array, missingPrices:string[], note:string|null}}
 */
export function computeCost({ tokens = {}, price = null } = {}) {
  const classes = [];
  let weighted = 0;          // Σ(token × 单价)，整数运算，最后才除 1e6
  let pricedTokens = 0;
  let unpricedTokens = 0;
  let anyPriceConfigured = false;
  const missingPrices = [];

  const currency = price && price.currency ? String(price.currency).toUpperCase() : '';

  for (const c of TOKEN_CLASSES) {
    const t = num(tokens[c.key]);
    const p = priceOf(price, c.priceField);
    if (p !== null) anyPriceConfigured = true;
    const priced = p !== null;
    if (t > 0) {
      if (priced) { pricedTokens += t; weighted += t * p; }
      else { unpricedTokens += t; missingPrices.push(c.key); }
    }
    classes.push({
      key: c.key, label: c.label, tokens: t,
      priceMinor: p, priced,
      // 这一类的金额也照给：便于页面逐行核对"是哪个价乘哪个量"
      amountMinor: priced ? Math.round((t * p) / 1_000_000) : null,
    });
  }

  // 单价配了但没币种 → 金额无法表达。宁可为 null，也不默认按人民币算。
  const noCurrency = anyPriceConfigured && !currency;
  // 没有任何"已定价 token"（或没有币种）→ null。**注意这里绝不是 0**：
  // 0 会被读成"这些调用没花钱"，而真相是"我们不知道花了多少"。
  const amountMinor = (pricedTokens > 0 && currency) ? Math.round(weighted / 1_000_000) : null;

  let note = null;
  if (!anyPriceConfigured) note = '该条目未登记单价 → 金额为 null（不是 0 元）';
  else if (noCurrency) note = '登记了单价但缺少币种 → 金额无法表达（请在模型条目上补 currency）';
  else if (unpricedTokens > 0) note = '部分 token 未定价，金额只覆盖已定价部分（偏保守，不是完整费用）';

  return {
    currency, amountMinor, amount: formatAmount(amountMinor, currency),
    pricedTokens, unpricedTokens,
    partial: unpricedTokens > 0 || !anyPriceConfigured || noCurrency,
    classes, missingPrices,
    note,
  };
}

/**
 * 把"用量行 + 模型条目"合成成本报告。**纯函数**（无 IO）。
 *
 * ⚠️ 输入 `rows` 有两种合法形状，本函数必须都吃：
 *   · 原始用量行（一行 = 一条 `usage_records`）—— 测试与将来按会话查明细时用；
 *   · `summarizeCost` 的 `GROUP BY model_id` 聚合行（一行 = 一组，带 `COUNT(*) AS usageRows`）。
 *   区分依据是 `usageRows` 字段（见 `rowsOf`）：没有就当 1。
 *
 * 归因规则：`usage_records.model_id`（上游模型名）匹配 `model_providers.model`。
 * 匹配不到就进 `unattributed` —— **不拿默认模型的价去套**：
 * 那会给出一个确定但错误的数，比"归因不到"更危险。
 *
 * @param {{rows:Array, providers:Array}} args
 */
export function buildCostReport({ rows = [], providers = [] } = {}) {
  // 同一模型名可能有多条登记（不同 priority）。按 (priority, id) 排序取第一个：
  // 与降级链的选法一致（链首就是实际会用的那条），且**确定**（不依赖数组顺序）。
  const byModelName = new Map();
  for (const p of providers) {
    const key = String(p.model || '');
    if (!key) continue;
    if (!byModelName.has(key)) byModelName.set(key, []);
    byModelName.get(key).push(p);
  }
  for (const arr of byModelName.values()) {
    arr.sort((a, b) => (Number(a.priority) - Number(b.priority)) || String(a.id).localeCompare(String(b.id)));
  }

  const grouped = new Map();     // modelId → tokens
  for (const r of rows) {
    const mid = String(r.model_id || '');
    if (!mid) continue;
    if (!grouped.has(mid)) grouped.set(mid, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usageRows: 0 });
    const g = grouped.get(mid);
    g.input += num(r.input);
    g.cacheRead += num(r.cache_read);
    g.cacheWrite += num(r.cache_write);
    g.output += num(r.output);
    g.usageRows += rowsOf(r);
  }

  const items = [];
  for (const mid of [...grouped.keys()].sort()) {
    const g = grouped.get(mid);
    const candidates = byModelName.get(mid) || [];
    const picked = candidates[0] || null;
    const cost = computeCost({
      tokens: { input: g.input, cacheRead: g.cacheRead, cacheWrite: g.cacheWrite, output: g.output },
      price: picked,
    });
    items.push({
      modelId: mid,
      usageRows: g.usageRows,
      tokens: { input: g.input, cacheRead: g.cacheRead, cacheWrite: g.cacheWrite, output: g.output },
      // 归因到哪个条目、以及**为什么是它**（多条同模型名时这件事必须可解释）
      provider: picked
        ? { id: picked.id, name: picked.name, kind: picked.kind, currency: picked.currency || '' }
        : null,
      providerCandidates: candidates.map((p) => ({ id: p.id, name: p.name, priority: Number(p.priority) })),
      ...cost,
    });
  }

  // 未归因：token 确实产生了，但我们不知道是哪个模型 —— 单独成桶，**不进金额**
  let unattributedTokens = 0;
  let unattributedRows = 0;
  for (const r of rows) {
    if (String(r.model_id || '')) continue;
    unattributedTokens += num(r.input) + num(r.cache_read) + num(r.cache_write) + num(r.output);
    unattributedRows += rowsOf(r);
  }

  // 合计**按币种分开**：把 CNY 与 USD 加在一起是个无意义的数
  const totalsByCurrency = {};
  let mixedCurrency = false;
  for (const it of items) {
    if (it.amountMinor === null) continue;
    const cur = it.currency;
    if (!totalsByCurrency[cur]) totalsByCurrency[cur] = { currency: cur, amountMinor: 0, pricedTokens: 0, unpricedTokens: 0, models: 0 };
    const t = totalsByCurrency[cur];
    t.amountMinor += it.amountMinor;
    t.pricedTokens += it.pricedTokens;
    t.unpricedTokens += it.unpricedTokens;
    t.models += 1;
  }
  for (const t of Object.values(totalsByCurrency)) t.amount = formatAmount(t.amountMinor, t.currency);
  if (Object.keys(totalsByCurrency).length > 1) mixedCurrency = true;

  // ⚠️ 这些 notes 会被前端**原样转义后**显示（`esc()`），所以里面不要写 Markdown ——
  //    星号会以字面量出现在页面上。要点靠中文表述讲清，不靠排版符号。
  const notes = [
    '金额口径：按当前登记的单价估算（单价是当下配置，不追溯历史）。',
    '未配单价的条目金额为 null，不显示为 0 元 —— 0 元会被读成"免费"。',
    'reasoning token 是 output 的子集，不另计；缓存价缺失时不用输入价顶替。',
  ];
  if (unattributedRows > 0) {
    notes.push('有 ' + unattributedRows + ' 行用量没有记录模型（model_id 为空），'
      + '共 ' + unattributedTokens + ' 个 token 未计入任何金额 —— '
      + '拿默认模型的单价去套会给出一个确定但错误的数，所以这里如实留着。');
  }
  if (items.some((x) => x.amountMinor === null)) {
    notes.push('有模型条目的用量金额为 null（未配单价或未配币种）—— 见每条的 note。');
  }

  return {
    items,
    unattributed: { usageRows: unattributedRows, tokens: unattributedTokens },
    totalsByCurrency,
    mixedCurrency,
    notes,
  };
}

/**
 * 从库里取用量行并算成本。providers 由装配层注入（governance 不认识 model 模块）。
 * @returns {{summary:object, window:{from:string|null, to:string|null}, sampleLimit:number}}
 */
export function summarizeCost({ tenantId, from = null, to = null, limit = 5000, resolveProviders = null } = {}) {
  const where = ['tenant_id = ?'];
  const params = [String(tenantId)];
  if (from) { where.push('created_at >= ?'); params.push(String(from)); }
  if (to) { where.push('created_at <= ?'); params.push(String(to)); }
  const W = where.join(' AND ');

  // 按模型聚合（不把明细全捞出来）：成本只关心"哪个模型用了多少"
  const rows = all(
    `SELECT model_id,
            SUM(input) AS input, SUM(cache_read) AS cache_read,
            SUM(cache_write) AS cache_write, SUM(output) AS output,
            COUNT(*) AS usageRows
       FROM usage_records WHERE ${W} /* tenant-ok: W 恒含 tenant_id（summarizeCost） */
      GROUP BY model_id ORDER BY output DESC LIMIT ?`,
    [...params, Number(limit) || 5000]
  );

  const providers = typeof resolveProviders === 'function' ? (resolveProviders(tenantId) || []) : [];
  const report = buildCostReport({ rows, providers });
  return { summary: report, window: { from, to }, sampleLimit: Number(limit) || 5000 };
}
