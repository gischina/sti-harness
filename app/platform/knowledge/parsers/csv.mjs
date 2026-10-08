/**
 * CSV / TSV 解析器（零依赖，RFC 4180 风格状态机）。
 *
 * 为什么自己写而不用 `split(',')`：企业导出的表格里引号内换行、
 * 字段里的逗号、`""` 转义都很常见。用 split 会把一行拆成几十行，
 * 而且**不报错** —— 正是本项目最反感的「静默失效」。
 *
 * 每个数据行输出一个 block（`kind:'table'`，带行号定位），
 * 行文本形如 `列名：值；列名：值` —— 这样「按列名检索」也能命中，
 * 而不是把一行裸值拼在一起（检索「负责人=张三」时无法区分是哪一列）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { stripBom, normSpace } from './util.mjs';

/** 猜分隔符：只在候选里选，并且按「表头列数一致性」投票，避免猜错还装作正常 */
export function detectDelimiter(sample, candidates = [',', '\t', ';', '|']) {
  const lines = String(sample || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (!lines.length) return ',';
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const counts = lines.map((l) => splitRow(l, d).length);
    const first = counts[0];
    if (first < 2) continue;
    const consistent = counts.filter((n) => n === first).length;
    const score = consistent * 100 + first;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** 单行拆分（处理引号与 `""` 转义）。返回字段数组。 */
export function splitRow(line, delimiter = ',') {
  const out = [];
  let cur = '';
  let quoted = false;
  const s = String(line == null ? '' : line);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => normSpace(x));
}

/**
 * 完整解析：正确处理「引号内的换行」（跨物理行的一条记录）。
 * @returns {string[][]} 记录数组
 */
export function parseRows(src, delimiter) {
  const s = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  let seenAny = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') { quoted = true; seenAny = true; continue; }
    if (ch === delimiter) { row.push(cur); cur = ''; seenAny = true; continue; }
    if (ch === '\n') {
      row.push(cur); cur = '';
      rows.push(row); row = [];
      seenAny = false;
      continue;
    }
    cur += ch;
    seenAny = true;
  }
  if (cur !== '' || row.length || seenAny) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((x) => normSpace(x)));
}

/**
 * @param {Buffer|string} input
 * @param {{filename?:string, delimiter?:string}} opts
 */
export function parseCsv(input, opts = {}) {
  const raw = Buffer.isBuffer(input) ? input.toString('utf8') : String(input == null ? '' : input);
  const src = stripBom(raw);
  const warnings = [];

  const byExt = /\.(tsv|tab)$/i.test(String(opts.filename || '')) ? '\t'
    : /\.(csv)$/i.test(String(opts.filename || '')) ? null : null;
  const delimiter = opts.delimiter || byExt || detectDelimiter(src);

  const rows = parseRows(src, delimiter);
  const nonEmpty = rows.filter((r) => r.some((c) => c !== ''));

  const blocks = [];
  const headings = [];
  if (!nonEmpty.length) {
    return {
      text: '', blocks, meta: { format: 'csv', rows: 0, columns: 0, delimiter },
      parser: 'csv', warnings: ['文件里没有可解析的数据行'],
    };
  }

  const header = nonEmpty[0];
  const hasHeader = nonEmpty.length > 1;
  const columns = header.length;

  if (hasHeader) {
    // 表头本身也作为可检索内容（用户常检索列名）
    blocks.push({ text: header.filter(Boolean).join(' '), kind: 'table-header', loc: { row: 1 } });
  }
  const startRow = hasHeader ? 1 : 0;
  for (let i = startRow; i < nonEmpty.length; i++) {
    const r = nonEmpty[i];
    const pairs = [];
    for (let c = 0; c < r.length; c++) {
      const v = r[c];
      if (!v) continue;
      const name = hasHeader && header[c] ? header[c] : ('第' + (c + 1) + '列');
      pairs.push(hasHeader ? name + '：' + v : v);
    }
    const text = pairs.join('；');
    if (text) blocks.push({ text, kind: 'table', loc: { row: i + 1 } });
  }

  // 不规则行的诚实提示：不静默截断
  const ragged = nonEmpty.slice(1).filter((r) => r.length !== columns).length;
  if (ragged) warnings.push('有 ' + ragged + ' 行的列数与表头不一致（已按行内实际列数解析）');

  const text = blocks.map((b) => b.text).join('\n');
  return {
    text,
    blocks,
    meta: { format: 'csv', rows: Math.max(0, nonEmpty.length - (hasHeader ? 1 : 0)), columns, delimiter, header: hasHeader ? header : [], headings },
    parser: 'csv',
    warnings,
  };
}
