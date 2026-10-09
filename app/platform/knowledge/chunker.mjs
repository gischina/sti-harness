/**
 * 分块器 —— 决定「一个 chunk 是什么」，也就决定了检索粒度和引用的可回溯程度。
 *
 * 四条规则（每一条都对应一个具体的坏结果）：
 *  1. **标题边界必断**：不跨章节合块，否则引用给出「某文档第 3 块」，
 *     读者无法判断这块属于哪一节。
 *  2. **页边界必断**：跨页合块会让「第 5 页」这个引用**变成错的**（内容其实横跨 5–6 页）。
 *     宁可多切一块，也不给出一个不成立的页码。
 *  3. **按句边界切**：长度超限时优先在 `。！？；\n` 处断句，
 *     而不是在第 800 个字符处硬切 —— 硬切会切碎一个词，检索质量直接掉。
 *  4. **保留重叠**：相邻块带一段重叠，避免答案刚好落在切口上而两块都召不回。
 *
 * 输出里带 `locationKnown`：**缺定位信息的分块必须被标记**（M2 验收标准 2），
 * 而不是让它混在结果里假装有出处。
 *
 * 纯函数、不碰数据库、不碰网络 —— 因此可以被穷举测试。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { splitSentences, estimateTokens } from './parsers/util.mjs';

export const DEFAULT_OPTIONS = {
  maxChars: 800,      // 单块正文长度上限（字符）
  overlapChars: 120,  // 相邻块重叠长度
  minChars: 80,       // 小于此长度的尾部块会并入上一块
  maxHeadingDepth: 3, // 标题路径只保留到第 N 级（更深的层级对引用没帮助，只会把路径撑长）
};

/** 这些块本身就是一个逻辑单元，不再按句切开 */
const ATOMIC_KINDS = new Set(['table', 'table-header', 'list', 'field', 'code']);

function pieceMeta(b) {
  const loc = b.loc || {};
  return {
    page: loc.page != null ? Number(loc.page) : null,
    anchor: loc.anchor || null,
    row: loc.row != null ? Number(loc.row) : null,
    kind: b.kind || 'text',
    level: b.level != null ? Number(b.level) : null,
  };
}

/**
 * @param {Array} blocks 解析器输出的块
 * @param {object} [options]
 * @returns {Array<{body:string, ord:number, tokenCount:number, meta:object}>}
 */
export function chunkBlocks(blocks, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const maxChars = Math.max(50, Number(o.maxChars) || DEFAULT_OPTIONS.maxChars);
  const overlapChars = Math.max(0, Math.min(Number(o.overlapChars) || 0, Math.floor(maxChars / 2)));
  const minChars = Math.max(0, Number(o.minChars) || 0);

  const list = Array.isArray(blocks) ? blocks.filter((b) => b && String(b.text || '').trim()) : [];
  if (!list.length) return [];

  // ── 1) 展平成 pieces（带上偏移与定位）─────────────────────────────
  const pieces = [];
  const headingPath = [];
  let offset = 0;

  for (const b of list) {
    const text = String(b.text || '').trim();
    const meta = pieceMeta(b);
    const start = offset;
    offset += text.length + 1;            // +1 对应拼接时的分隔符

    if (b.kind === 'heading') {
      const level = Math.max(1, meta.level || 1);
      headingPath.length = Math.min(headingPath.length, level - 1);
      headingPath[level - 1] = text;
      for (let i = 0; i < headingPath.length; i++) if (headingPath[i] === undefined) headingPath[i] = '';
      // 标题文本本身也进 pieces：检索「章节名」应当能命中
      pieces.push({ text, start, end: start + text.length, ...meta, isHeading: true, path: headingPath.filter(Boolean).slice(0, o.maxHeadingDepth) });
      continue;
    }

    const path = headingPath.filter(Boolean).slice(0, o.maxHeadingDepth);
    if (ATOMIC_KINDS.has(b.kind) || text.length <= maxChars) {
      pieces.push({ text, start, end: start + text.length, ...meta, isHeading: false, path });
      continue;
    }

    // 长正文：按句切开
    let cursor = start;
    for (const sentence of splitSentences(text)) {
      if (sentence.length > maxChars) {
        // 单句超长（例如没有标点的长表格行/长串）：硬切，但按 maxChars 对齐
        for (let i = 0; i < sentence.length; i += maxChars) {
          const part = sentence.slice(i, i + maxChars);
          pieces.push({ text: part, start: cursor, end: cursor + part.length, ...meta, isHeading: false, path });
          cursor += part.length;
        }
      } else {
        pieces.push({ text: sentence, start: cursor, end: cursor + sentence.length, ...meta, isHeading: false, path });
        cursor += sentence.length;
      }
    }
  }

  if (!pieces.length) return [];

  // ── 2) 打包成块 ────────────────────────────────────────────────
  const chunks = [];
  let cur = null;

  const openChunk = (piece) => ({
    body: piece.text,
    last: piece.text,
    first: { ...piece },
    chars: piece.text.length,
    rows: piece.row != null ? [piece.row, piece.row] : null,
    pages: piece.page != null ? [piece.page, piece.page] : null,
    paths: piece.path ? piece.path.slice() : [],
    anchors: piece.anchor ? [piece.anchor] : [],
    kinds: new Set([piece.kind]),
  });

  const addTo = (c, piece) => {
    c.body += '\n' + piece.text;
    c.last = piece.text;
    c.chars += piece.text.length + 1;
    if (piece.row != null) c.rows = c.rows ? [c.rows[0], piece.row] : [piece.row, piece.row];
    if (piece.page != null) c.pages = c.pages ? [c.pages[0], piece.page] : [piece.page, piece.page];
    if (piece.anchor) c.anchors.push(piece.anchor);
    if (piece.path && piece.path.length) c.paths = piece.path.slice();
    c.kinds.add(piece.kind);
  };

  const seal = (c) => {
    if (!c || !String(c.body).trim()) return;
    const pages = uniqRange(c.pages);
    const anchors = [...new Set(c.anchors)];
    const path = c.paths || [];
    const heading = path.length ? path[path.length - 1] : null;
    // 「有没有定位信息」必须把行号也算上：CSV/JSON 的行号是真能回溯到原文件第几行的。
    // （早先漏了 rows，导致「人员.csv 第 2 行」这种明明可定位的分块被标成"无定位信息"。）
    const hasRows = !!(c.rows && (c.rows[0] != null || c.rows[1] != null));
    const locationKnown = !!(pages.length || anchors.length || heading || hasRows);
    chunks.push({
      body: c.body.trim(),
      ord: chunks.length,
      tokenCount: estimateTokens(c.body),
      meta: {
        heading,
        headingPath: path,
        level: c.first.level,
        pages,
        page: pages.length === 1 ? pages[0] : null,
        anchor: anchors[0] || null,
        anchors,
        rowStart: c.rows ? c.rows[0] : null,
        rowEnd: c.rows ? c.rows[1] : null,
        // [charStart, charEnd) —— 相对「所有块按 \n 拼接后」的偏移，用户可据此核对原文
        charStart: c.first.start,
        charEnd: c.first.start + c.chars,
        kinds: [...c.kinds],
        locationKnown,
      },
    });
  };

  for (const p of pieces) {
    if (!cur) { cur = openChunk(p); continue; }

    const lastPage = cur.pages ? cur.pages[cur.pages.length - 1] : null;
    const pageBreak = p.page != null && lastPage != null && p.page !== lastPage;
    const headingBreak = p.isHeading || (p.path && cur.paths && p.path.join('\u0000') !== cur.paths.join('\u0000'));

    if (pageBreak || headingBreak) { seal(cur); cur = openChunk(p); continue; }

    addTo(cur, p);
    if (cur.chars >= maxChars) {
      const carried = overlapCarry(cur, overlapChars);
      seal(cur);
      cur = carried ? openChunk(carried) : null;
    }
  }
  seal(cur);

  // ── 3) 尾部小块的收拢 ──────────────────────────────────────────
  // ⚠️ 收拢**不得**跨页、跨章节：那会把已经正确的页码/标题引用又变回错的。
  //    （这条曾经写漏过：尾部一句「第三页内容丙。」被并回第二页那块，
  //      页码从 2 变成「跨 2–3 页」，等于引用失效。）
  if (chunks.length >= 2 && minChars > 0) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    const sameHeading = (prev.meta.heading || null) === (last.meta.heading || null);
    const sameAnchor = (prev.meta.anchor || null) === (last.meta.anchor || null);
    const pagesCompatible = !last.meta.pages.length || !prev.meta.pages.length
      || (last.meta.pages.length === 1 && prev.meta.pages.length === 1 && last.meta.pages[0] === prev.meta.pages[0]);
    if (last.body.length < minChars && sameHeading && sameAnchor && pagesCompatible
      && (prev.body.length + last.body.length + 1) <= maxChars * 1.6) {
      prev.body = prev.body + '\n' + last.body;
      prev.tokenCount = estimateTokens(prev.body);
      prev.meta.charEnd = last.meta.charEnd;
      prev.meta.pages = [...new Set(prev.meta.pages.concat(last.meta.pages))].sort((a, b) => a - b);
      prev.meta.page = prev.meta.pages.length === 1 ? prev.meta.pages[0] : null;
      prev.meta.rowStart = prev.meta.rowStart != null ? prev.meta.rowStart : last.meta.rowStart;
      prev.meta.rowEnd = last.meta.rowEnd != null ? last.meta.rowEnd : prev.meta.rowEnd;
      prev.meta.kinds = [...new Set(prev.meta.kinds.concat(last.meta.kinds))];
      prev.meta.locationKnown = !!(prev.meta.pages.length || prev.meta.anchors.length || prev.meta.heading
        || prev.meta.rowStart != null || prev.meta.rowEnd != null);
      chunks.pop();
    }
  }

  return chunks.map((c, i) => ({ ...c, ord: i }));
}

/** 取尾部若干句作为重叠段（用于下一块的开头） */
function overlapCarry(c, overlapChars) {
  if (!overlapChars) return null;
  const sentences = splitSentences(c.body);
  const tail = [];
  let len = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (i === sentences.length - 1 && len === 0 && sentences[i].length > overlapChars) break; // 最后一句本身就超长，不重叠
    tail.unshift(sentences[i]);
    len += sentences[i].length;
    if (len >= overlapChars) break;
  }
  if (!tail.length || len > overlapChars * 2) return null;
  const text = tail.join('');
  if (!text.trim()) return null;
  return {
    text,
    start: Math.max(0, c.first.start + c.chars - text.length),
    end: c.first.start + c.chars,
    page: c.pages && c.pages.length ? c.pages[c.pages.length - 1] : null,
    anchor: c.anchors.length ? c.anchors[c.anchors.length - 1] : null,
    row: c.rows ? c.rows[1] : null,
    kind: 'overlap',
    level: c.first.level,
    isHeading: false,
    path: (c.paths || []).slice(),
  };
}

function uniqRange(pair) {
  if (!pair) return [];
  const [a, b] = pair;
  const out = [];
  for (let i = a; i <= b && out.length < 64; i++) out.push(i);
  return out;
}

/** 便捷入口：把一段纯文本当作单个块来分块（导入"纯文本"时不经过文件） */
export function chunkText(text, options = {}) {
  return chunkBlocks([{ text: String(text || ''), kind: 'text' }], options);
}
