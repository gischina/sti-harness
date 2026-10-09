/**
 * 纯文本 / Markdown 解析器（零依赖）。
 *
 * 输出 **blocks**（结构化块）而不是一整坨字符串 —— 因为分块器需要知道
 * 「哪些是标题、标题在第几级」才能做标题层级分块；把整段文本丢给分块器，
 * 它只能按长度硬切，引用就只剩「第 3 块」这种没法回溯的定位。
 *
 * Markdown 支持范围（刻意克制，不做完整 CommonMark）：
 *   · ATX 标题 `#`~`######`、Setext 标题（`===` / `---` 下划线）
 *   · 围栏代码块 ``` 与 ~~~
 *   · 无序/有序列表项（保留为独立块，便于引用到具体条目）
 *   · 其余按空行分段
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { stripBom, joinWrapped, normSpace } from './util.mjs';

const ATX = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const SETEXT = /^\s*(=+|-{2,})\s*$/;

/**
 * @param {Buffer|string} input
 * @param {{filename?:string, markdown?:boolean}} opts
 * @returns {{text:string, blocks:Array, meta:object, parser:string, warnings:string[]}}
 */
export function parseText(input, opts = {}) {
  const raw = Buffer.isBuffer(input) ? input.toString('utf8') : String(input == null ? '' : input);
  const src = stripBom(raw).replace(/\r\n?/g, '\n');
  const isMd = opts.markdown !== undefined
    ? !!opts.markdown
    : /\.(md|markdown|mdx)$/i.test(String(opts.filename || ''));

  const blocks = [];
  const headings = [];
  const lines = src.split('\n');

  let para = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf = [];

  const flushPara = () => {
    if (!para.length) return;
    const text = joinWrapped(para);
    if (text) blocks.push({ text, kind: 'text' });
    para = [];
  };
  const flushCode = () => {
    if (!codeBuf.length) return;
    const text = codeBuf.join('\n').replace(/\s+$/, '');
    if (text) blocks.push({ text, kind: 'code', lang: codeLang || null });
    codeBuf = [];
    codeLang = '';
  };

  const pushHeading = (level, text, setextLevel) => {
    const t = normSpace(text);
    if (!t) return;
    blocks.push({ text: t, kind: 'heading', level: setextLevel || level });
    headings.push({ level: setextLevel || level, text: t });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inCode) {
      if (FENCE.test(line)) { flushCode(); inCode = false; continue; }
      codeBuf.push(line);
      continue;
    }

    const f = isMd ? FENCE.exec(line) : null;
    if (f) { flushPara(); inCode = true; codeLang = f[2] || ''; continue; }

    if (isMd) {
      const h = ATX.exec(line);
      if (h) { flushPara(); pushHeading(h[1].length, h[2], 0); continue; }

      // Setext：当前行非空且下一行是 === / ---
      const next = lines[i + 1];
      if (line.trim() && next !== undefined && SETEXT.test(next)) {
        const marks = next.trim();
        // `---` 也可能是分隔线；只有当前行有实义文本时才当标题
        flushPara();
        pushHeading(0, line, marks[0] === '=' ? 1 : 2);
        i++;
        continue;
      }

      const ul = UL.exec(line);
      if (ul && ul[1].trim()) { flushPara(); blocks.push({ text: normSpace(ul[1]), kind: 'list', ordered: false }); continue; }
      const ol = OL.exec(line);
      if (ol && ol[1].trim()) { flushPara(); blocks.push({ text: normSpace(ol[1]), kind: 'list', ordered: true }); continue; }
    }

    if (!line.trim()) { flushPara(); continue; }
    para.push(line);
  }

  if (inCode) { flushCode(); /* 未闭合的围栏：按代码块收尾，不报错 */ }
  flushPara();

  const text = blocks.map((b) => b.text).join('\n\n');
  return {
    text,
    blocks,
    meta: {
      format: isMd ? 'markdown' : 'text',
      lines: lines.length,
      headings,
    },
    parser: isMd ? 'markdown' : 'text',
    warnings: [],
  };
}

/** 是否像 Markdown（内容启发式，供 mime/扩展名都不可靠时兜底） */
export function looksLikeMarkdown(s) {
  const t = String(s || '');
  return /^#{1,6}\s+\S/m.test(t) || /^```/m.test(t);
}
