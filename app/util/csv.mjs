/**
 * CSV 解析（带物理行号）—— 账号批量导入专用。
 *
 * 为什么不用 `platform/knowledge/parsers/csv.mjs` 的 parseCsv：
 *   1. 那个解析器面向"检索语料"，会做空白规整 —— 对文本检索是对的，
 *      对**口令**是毁灭性的（结尾空格被吃掉，导入的人从此登不上）；
 *   2. 它按"块"返回正文，不保留**物理行号** —— 而导入报表必须能说
 *      "第 7 行失败"，让人回 Excel 里定位。
 *
 * 支持的 CSV 约定（够用即可，不做 RFC 4180 全量）：
 *   · 逗号分隔；双引号包裹字段；引号内 `""` 表示一个字面引号
 *   · 引号内换行属于字段内容（不算逻辑行界），物理行号照常累加
 *   · CRLF / CR / LF 都认（先统一成 \n）；首个 BOM 剥掉（Excel 导出常带）
 *
 * 诚实失败：引号没闭合 → 抛 400，而不是把整份文件当成一个巨大字段 ——
 * 那会安静地产生一串"串行垃圾"，报表还显示导入成功。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { errors } from './errors.mjs';

/** 返回 `[{ line, cells }]`：line 是记录起始的**物理行号**（1 起，表头是第 1 行）。 */
export function parseCsvRecords(text, { delimiter = ',' } = {}) {
  const s = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const out = [];
  let cells = [];
  let cur = '';
  let quoted = false;
  let line = 1;          // 当前物理行
  let recordLine = 1;    // 当前记录起始的物理行
  let quoteOpenLine = 0; // 引号开启处 —— 未闭合时报错要指向它

  const endCell = () => { cells.push(cur); cur = ''; };
  const endRecord = () => {
    endCell();
    // 只有一个空单元格 = 空行（含尾随空行、`,,,` 这种全空记录）—— 不产出，留给调用方判"没有数据"
    if (cells.length > 1 || cells[0] !== '') out.push({ line: recordLine, cells });
    cells = [];
    recordLine = line;
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else {
        if (ch === '\n') line++;
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      // 字段开头的引号才是"包裹"；字段中间冒出的引号（非规范输入）当字面量，不造错
      if (cur === '') { quoted = true; quoteOpenLine = line; }
      else cur += ch;
      continue;
    }
    if (ch === delimiter) { endCell(); continue; }
    if (ch === '\n') { line++; endRecord(); continue; }
    cur += ch;
  }
  if (quoted) {
    throw errors.badRequest('CSV 格式有误：第 ' + quoteOpenLine + ' 行的引号没有闭合'
      + '（引号里的换行会被当成字段内容，整份文件因此串行）。请检查该行后重试。');
  }
  if (cur !== '' || cells.length > 0) endRecord(); // 文件不以换行结尾时的最后一条
  return out;
}
