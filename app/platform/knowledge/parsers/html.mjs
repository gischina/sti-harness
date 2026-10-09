/**
 * HTML 解析器（零依赖，标签级扫描）。
 *
 * 为什么不用正则一把梭：正则抠文本会把 `<script>` 里的 JS、
 * `<style>` 里的 CSS 一起当成正文抓进来 —— 于是检索「函数」会命中一堆代码，
 * 而真正的正文反而被淹没。这里先剥掉 `<head>` 与脚本/样式，再按块级标签切分。
 *
 * 产出块级结构（标题保留 `id` 作为锚点），使引用能定位到
 * 「文档 → 章节标题 / 锚点」，而不是只能给出一个分块序号。
 *
 * 表格处理：首行若全为 `<th>`，则后续行渲染成 `列名：值` —— 让
 * 「按列名检索」也能命中，而不是把一行裸值拼在一起。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { decodeEntities, normSpace } from './util.mjs';

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'blockquote', 'pre', 'figure', 'figcaption', 'dd', 'dt', 'form', 'fieldset',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'hr', 'br',
  ...HEADINGS,
]);
/** 内容整体丢弃的标签（含 head：标题单独抽取，不当作正文） */
const DROP_TAGS = ['head', 'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object'];

function stripBlocks(src) {
  let out = String(src || '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROP_TAGS) {
    out = out.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi'), ' ');
    // 自闭合 / 未闭合的也要丢掉（注释掉一半的脚本会污染正文）
    out = out.replace(new RegExp('<' + tag + '\\b[^>]*\\/?>', 'gi'), ' ');
  }
  return out;
}

function attrValue(attrs, name) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
  const m = re.exec(attrs || '');
  if (!m) return null;
  const v = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
  return v ? decodeEntities(v) : null;
}

/** 各块级标签在「闭合」时应产出的块类型 */
function kindForTag(tag) {
  if (tag === 'li') return 'list';
  if (tag === 'tr' || tag === 'table' || tag === 'td' || tag === 'th') return 'table';
  if (tag === 'pre') return 'code';
  return 'text';
}

/**
 * @param {Buffer|string} input
 * @param {{filename?:string}} opts
 */
export function parseHtml(input, opts = {}) {
  const raw = Buffer.isBuffer(input) ? input.toString('utf8') : String(input == null ? '' : input);
  const warnings = [];

  // 标题必须在剥 head 之前取
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(raw);
  const title = titleMatch ? normSpace(decodeEntities(titleMatch[1])) : '';

  const src = stripBlocks(raw);
  const blocks = [];
  const headings = [];
  let linkCount = 0;

  let buf = '';
  let headingLevel = 0;
  let headingAnchor = null;
  let currentAnchor = null;      // 最近出现的元素 id，作为后续文本的定位锚点
  let pendingKind = 'text';

  // 表格状态
  let row = [];
  let rowAllTh = true;
  let inCell = false;
  let tableHeaderRow = null;
  let tableOpen = false;

  const locNow = () => (currentAnchor ? { anchor: currentAnchor } : {});

  const flush = (kind) => {
    const text = normSpace(buf);
    buf = '';
    if (!text) return;
    blocks.push({ text, kind: kind || pendingKind || 'text', loc: locNow() });
  };

  const flushHeading = () => {
    const text = normSpace(buf);
    buf = '';
    const lvl = headingLevel || 2;
    headingLevel = 0;
    if (!text) { headingAnchor = null; return; }
    const loc = headingAnchor ? { anchor: headingAnchor } : locNow();
    blocks.push({ text, kind: 'heading', level: lvl, loc });
    headings.push({ level: lvl, text, anchor: loc.anchor || null });
    headingAnchor = null;
  };

  const flushRow = () => {
    const cells = row.filter((c) => c !== '');
    const allTh = rowAllTh;
    row = [];
    rowAllTh = true;
    if (!cells.length) return;
    if (!tableHeaderRow && allTh && cells.length) {
      tableHeaderRow = cells.slice();
      blocks.push({ text: cells.join(' '), kind: 'table-header', loc: locNow() });
      return;
    }
    const header = tableHeaderRow && tableHeaderRow.length === cells.length ? tableHeaderRow : null;
    const text = cells.map((c, i) => (header && header[i] ? header[i] + '：' + c : c)).join('；');
    blocks.push({ text, kind: 'table', loc: locNow() });
  };

  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let last = 0;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const between = src.slice(last, m.index);
    if (between) buf += decodeEntities(between);
    last = tagRe.lastIndex;

    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';

    if (HEADINGS.has(tag)) {
      if (closing) flushHeading();
      else {
        flush(pendingKind);
        headingLevel = Number(tag.slice(1));
        headingAnchor = attrValue(attrs, 'id') || attrValue(attrs, 'name') || null;
        if (headingAnchor) currentAnchor = headingAnchor;
      }
      continue;
    }

    if (tag === 'a' && !closing) {
      if (attrValue(attrs, 'href')) linkCount++;
      continue;
    }

    if (tag === 'td' || tag === 'th') {
      if (closing) {
        row.push(normSpace(buf));
        buf = '';
        inCell = false;
        if (tag === 'th') { /* 保持 rowAllTh */ } else rowAllTh = false;
      } else {
        inCell = true;
        buf = '';
      }
      continue;
    }

    if (tag === 'tr') {
      if (closing) flushRow();
      else { flush(pendingKind); row = []; rowAllTh = true; }
      continue;
    }

    if (tag === 'table') {
      if (closing) { tableOpen = false; flush('table'); } else { flush(pendingKind); tableOpen = true; }
      continue;
    }

    if (!closing) {
      const id = attrValue(attrs, 'id');
      if (id) currentAnchor = id;
    }

    if (BLOCK_TAGS.has(tag)) {
      if (inCell) continue;                     // 单元格内不切块
      if (closing) { flush(kindForTag(tag)); pendingKind = 'text'; }
      else { flush(pendingKind); pendingKind = kindForTag(tag); }
    }
  }

  if (!inCell) flush(pendingKind);
  const tail = src.slice(last);
  if (tail.trim()) {
    const t = normSpace(decodeEntities(tail));
    if (t) blocks.push({ text: t, kind: 'text', loc: locNow() });
  }

  if (tableOpen) warnings.push('表格标签可能未闭合，已按实际解析结果输出');

  const text = blocks.map((b) => b.text).join('\n\n');
  return {
    text,
    blocks,
    meta: { format: 'html', title, headings, linkCount },
    parser: 'html',
    warnings,
  };
}
