/**
 * 中文 bigram 切分 —— 中文全文检索的**唯一可行路径**。
 *
 * 为什么必须这么做（实测结论，详见 docs/feasibility.md §1.2.1）：
 * SQLite FTS5 的 unicode61 tokenizer 把**一整段连续汉字当成一个 token**
 * （CJK 之间没有分隔符），于是：
 *     MATCH '权限管理' → 0 命中
 *     MATCH '权限'     → 0 命中     只有整句或前缀命中
 * trigram tokenizer（3.34+）虽能匹配 ≥3 字的词，但对 **2 字词**（「权限」「管理」「平台」）
 * 召回为 0 —— 而中文场景里 2 字词占比极高，因此 trigram 不可用。
 *
 * 做法：写入侧把 CJK 连续串切成**重叠双字串**（企业级 → 企业 业级），
 * 用空格分隔后交给 unicode61 索引；查询侧做同样切分再匹配。
 * 英文/数字保持原样按空格切词，两条路径互不干扰。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */

// CJK 汉字 + 假名 + 谚文 + 兼容区
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const CJK_GLOBAL = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
// 作为「词边界」的标点/空白（中英文标点都算）
const SEPARATOR = /[\s\u3000-\u303f\uff00-\uffef!-/:-@\[-`{-~]+/;

/** 一个片段是否是 CJK 字符 */
export function isCjk(ch) {
  return CJK.test(ch);
}

/** 把文本切成 [CJK 片段] 与 [非 CJK 片段] 交替的数组（保留先后顺序） */
function segment(text) {
  const s = String(text || '');
  const out = [];
  let buf = '';
  let bufIsCjk = null;
  for (const ch of s) {
    const c = isCjk(ch);
    if (bufIsCjk === null) { bufIsCjk = c; buf = ch; continue; }
    if (c === bufIsCjk) { buf += ch; continue; }
    out.push({ cjk: bufIsCjk, text: buf });
    bufIsCjk = c;
    buf = ch;
  }
  if (buf) out.push({ cjk: bufIsCjk, text: buf });
  return out;
}

/**
 * 把一段中英混排文本切成索引词条。
 * - CJK 片段 → 重叠双字串（长度 1 时保留单字）
 * - 非 CJK 片段 → 按分隔符切词，转小写
 * @returns {string[]}
 */
export function tokenize(text) {
  const tokens = [];
  for (const seg of segment(text)) {
    if (seg.cjk) {
      const chars = [...seg.text];
      if (chars.length === 1) tokens.push(chars[0]);
      else for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
    } else {
      for (const w of seg.text.split(SEPARATOR)) {
        const t = w.trim().toLowerCase();
        if (t) tokens.push(t);
      }
    }
  }
  return tokens;
}

/** 索引串：写入 chunks.bigrams 用 */
export function toIndexText(text) {
  return tokenize(text).join(' ');
}

/**
 * 生成 FTS5 查询串。
 * @param {string} query 用户输入
 * @param {{mode?:'phrase'|'or'|'any'}} opts
 *   phrase（默认）：CJK 部分作**保序短语**匹配（精确）；段与段之间 AND。
 *   or：CJK 部分作 **OR** 组合 —— 段内容忍换序；段与段之间**仍** AND。
 *   any：**全局 OR** —— 丢掉段间 AND，任一词条命中即可。这是"整句提问"的最后一道网。
 *
 *   ⚠️ 两条都是实测证伪后改出来的，别凭直觉改回去：
 *
 *   ① `or` 档曾经写成段内 AND：查询「管理权限」切出 管理/理权/权限 三个双字串，
 *      而原文「权限管理」里**没有「理权」**，于是 0 命中 ——
 *      本想容忍换序，结果把换序彻底挡住了。改 OR 后由 bm25 排序，
 *      命中双字串更多的分块自然排前面，换序与漏字都能召回。
 *
 *   ② 只有 ① 还不够。用户**不会**只输关键词，他们会输整句：
 *        「根据知识库：备份怎么做？只回答一句话」
 *      标点被 segment 切成三段，段间 AND 要求**每一段**都至少命中一个双字串。
 *      而文档里根本没有「只回答一句话」这层意思 → 一个从句就把整条查询判死，
 *      连"备份"这种板上钉钉的命中都召不回来（真机实测：整句 0 命中，拆成「备份」才 1 命中）。
 *      所以补 `any` 档：段间约束全部放开，只留 OR + bm25 排序。
 *      这**不会**让结果变脏 —— 相关度低的分块被 bm25 排到后面，且只在前两档全 0 时才启用。
 *
 * 词条统一用双引号包裹 —— FTS5 的字符串字面量语法是双引号。
 */
export function toMatchQuery(query, opts = {}) {
  const mode = opts.mode === 'or' || opts.mode === 'any' ? opts.mode : 'phrase';
  const q = (s) => '"' + String(s).replace(/"/g, '') + '"';

  // 先把查询切成「段 → 词条」，三种档位共用这一份切分结果（不重复切，避免口径漂移）
  const segs = [];
  for (const seg of segment(query)) {
    if (seg.cjk) {
      const chars = [...seg.text];
      if (!chars.length) continue;
      if (chars.length === 1) { segs.push({ kind: 'cjk', terms: [chars[0]] }); continue; }
      const grams = [];
      for (let i = 0; i < chars.length - 1; i++) grams.push(chars[i] + chars[i + 1]);
      segs.push({ kind: 'cjk', terms: grams });
    } else {
      const words = [];
      for (const w of seg.text.split(SEPARATOR)) {
        const t = w.trim().toLowerCase().replace(/"/g, '');
        if (t) words.push(t);
      }
      if (words.length) segs.push({ kind: 'latin', terms: words });
    }
  }
  if (!segs.length) return '';

  if (mode === 'any') {
    const all = segs.flatMap((s) => s.terms).map(q);
    return all.length > 1 ? '(' + all.join(' OR ') + ')' : all.join(' OR ');
  }

  const parts = segs.map((s) => {
    if (s.kind === 'latin') return s.terms.map(q).join(' AND ');
    if (mode === 'phrase') return q(s.terms.join(' '));   // 保序短语
    return '(' + s.terms.map(q).join(' OR ') + ')';        // 段内 OR（单字也裹括号，保持串形稳定）
  });
  return parts.join(' AND ');
}

/**
 * 降级链：精确（保序短语）→ 段内 OR（容忍换序）→ 全局 OR（容忍多从句）。
 * 空查询返回空数组。检索层按顺序尝试，先命中即用，并在结果里标注实际用了哪一档。
 *
 * 相同串不重复入链：单段查询的 `or` 与 `any` 本来就同串，没必要多跑一次 SQL。
 */
export function buildQueryLadder(query) {
  const ladder = [];
  const seen = new Set();
  for (const mode of ['phrase', 'or', 'any']) {
    const match = toMatchQuery(query, { mode });
    if (!match || seen.has(match)) continue;
    seen.add(match);
    ladder.push({ mode, match });
  }
  return ladder;
}
