/**
 * 解析器公共工具。
 *
 * 这里的每一个函数都只为解决一个**实测过的具体问题**，不做通用文本库：
 *  · `joinWrapped`：中文资料被硬换行切断时，若按英文习惯补空格，
 *    会把「权限\n管理」变成「权限 管理」——bigram 切出的「限管」就没了，召回直接掉。
 *  · `decodeEntities`：HTML 不先解实体，检索「&amp;」这类噪声会污染 bigram。
 *  · `stripBom`：Windows 记事本存的 UTF-8 带 BOM，不剥掉会让第一个标题认不出来。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { isCjk } from '../../../util/bigram.mjs';

export const BOM = '\uFEFF';

export function stripBom(s) {
  const t = String(s == null ? '' : s);
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

/** 全角空格、制表符、连续空白 → 单个半角空格（保留换行时请先用别的函数） */
export function normSpace(s) {
  return String(s == null ? '' : s).replace(/[\t\v\f\r\u00a0\u3000 ]+/g, ' ').trim();
}

/**
 * 合并被硬换行折断的若干行。
 * 规则：相邻两字符**都是 CJK** 时不加空格（中文没有词间空格），其余情况加空格。
 * 这样「权限\n管理」→「权限管理」（bigram 得「权限」「限管」「管理」三连），
 * 而「hello\nworld」→「hello world」保持英文可检索。
 */
export function joinWrapped(lines) {
  const parts = lines.map((l) => String(l == null ? '' : l).trim()).filter(Boolean);
  let out = '';
  for (const p of parts) {
    if (!out) { out = p; continue; }
    const a = out[out.length - 1];
    const b = p[0];
    out += (isCjk(a) && isCjk(b)) ? '' : ' ';
    out += p;
  }
  return out;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', middot: '\u00b7',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0',
  laquo: '\u00ab', raquo: '\u00bb', times: '\u00d7', divide: '\u00f7',
  larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193',
};

/** 解码常见 HTML 实体（含数字实体）。不引入第三方库，够用即可。 */
export function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
  });
}

/** 估算 token 数：CJK 按 1 字 1 token，其余按 ~4 字符 1 token（只用于展示与排序，不用于计费） */
export function estimateTokens(s) {
  const t = String(s == null ? '' : s);
  let cjk = 0;
  let other = 0;
  for (const ch of t) {
    if (isCjk(ch)) cjk++; else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** 把文本按「句边界」切开，用于分块时优先在语义边界处断句 */
export function splitSentences(s) {
  const out = [];
  let buf = '';
  for (const ch of String(s == null ? '' : s)) {
    buf += ch;
    if ('。！？；!?;\n'.includes(ch)) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}
