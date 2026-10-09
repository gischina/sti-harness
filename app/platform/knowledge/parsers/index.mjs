/**
 * 解析调度器 —— 按扩展名/mime 选择解析器，并**实测**报告本机能力。
 *
 * 路由原则：**扩展名优先，mime 兜底**。
 * 实测过：浏览器上传 .md 时常给 `text/plain`，而 .csv 常常直接给
 * `application/vnd.ms-excel`（历史遗留）—— 只看 mime 会把 Markdown 当纯文本、
 * 把 CSV 当 Excel 二进制。扩展名是用户自己起的，更可信。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { parseText, looksLikeMarkdown } from './text.mjs';
import { parseCsv } from './csv.mjs';
import { parseJson } from './json.mjs';
import { parseHtml } from './html.mjs';
import { parsePdf, parseOffice, probeExternalTools, ParserUnavailableError, ParserFailedError } from './external.mjs';

export { ParserUnavailableError, ParserFailedError, probeExternalTools };

const EXT_MAP = {
  txt: 'text', text: 'text', log: 'text', ini: 'text', conf: 'text', env: 'text', yaml: 'text', yml: 'text', toml: 'text',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  csv: 'csv', tsv: 'csv', tab: 'csv',
  json: 'json', jsonl: 'json', ndjson: 'json',
  html: 'html', htm: 'html', xhtml: 'html',
  pdf: 'pdf',
  docx: 'office', doc: 'office', rtf: 'office', odt: 'office',
  xlsx: 'office', xls: 'office', ods: 'office',
  pptx: 'office', ppt: 'office', odp: 'office',
};

const MIME_MAP = [
  [/^application\/pdf$/i, 'pdf'],
  [/^text\/html/i, 'html'],
  [/^text\/csv$/i, 'csv'],
  [/^text\/tab-separated-values$/i, 'csv'],
  [/^application\/json/i, 'json'],
  [/^text\/markdown/i, 'markdown'],
  [/^text\/plain/i, 'text'],
  [/wordprocessingml\.document|msword|opendocument\.text/i, 'office'],
  [/spreadsheetml\.sheet|ms-excel|opendocument\.spreadsheet/i, 'office'],
  [/presentationml\.presentation|ms-powerpoint|opendocument\.presentation/i, 'office'],
];

/** 纯 Node 就能解析的格式（不依赖任何外部命令） */
export const NATIVE_FORMATS = ['text', 'markdown', 'csv', 'json', 'html'];

export function extOf(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

/** @returns {string} 格式类别；无法识别时返回 'unsupported' */
export function detectFormat(filename, mime) {
  const ext = extOf(filename);
  if (ext && EXT_MAP[ext]) return EXT_MAP[ext];
  const m = String(mime || '');
  for (const [re, kind] of MIME_MAP) if (re.test(m)) return kind;
  return 'unsupported';
}

/** 机器可读能力清单（状态页/自检/前端展示当前解析与检索能力） */
export function parserCapabilities(opts = {}) {
  const tools = probeExternalTools(opts);
  return {
    native: NATIVE_FORMATS.slice(),
    nativeExtensions: ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'html', 'htm'],
    external: {
      pdftotext: { available: tools.pdftotext.available, version: tools.pdftotext.version || null, provides: ['pdf'], hint: tools.pdftotext.hint },
      office: { available: tools.office.available, version: tools.office.version || null, provides: tools.office.provides, hint: tools.office.hint },
    },
    unsupportedExtensions: ['doc(docx 除外)', 'zip', 'png/jpg', 'mp4', 'exe', 'dwg', 'shp'],
    notes: [
      '纯 Node 解析：txt / md / csv / tsv / json / jsonl / html —— 不需要任何外部命令。',
      '外部命令解析：pdf 需要 pdftotext（poppler）；docx/xlsx/pptx 需要 LibreOffice。',
      '检测不到外部命令时，该格式的文档会明确失败并给出安装提示，不会把二进制当文本索引。',
      '扫描件 PDF（图片型）即使有 pdftotext 也抽不出文字，会在结果里告警提示需要 OCR。',
    ],
  };
}

/**
 * 解析一个文档。
 *
 * @param {{buffer?:Buffer|Uint8Array, text?:string, filename?:string, mime?:string}} input
 * @returns {{text:string, blocks:Array, meta:object, parser:string, degraded:boolean, warnings:string[]}}
 * @throws {ParserUnavailableError|ParserFailedError|Error}
 */
export function parseDocument(input = {}) {
  const filename = String(input.filename || '');
  const mime = String(input.mime || '');
  const hasBuffer = input.buffer != null;

  /**
   * ⚠️ 这里曾经写成 `hasBuffer || !input.text ? detectFormat(...) : 'text'` ——
   * 也就是"只有文本、没有 buffer 时一律按纯文本处理"，**把文件名与类型给的格式线索丢了**。
   * 后果是实测出来的：把 Markdown 粘进来（或按 .md 走文本接口）时，`# 标题` 原样留在正文里，
   * 标题层级丢失 → 分块的 `headingPath` 为空、`locationKnown=false` →
   * 引用链退化成一整篇"无定位信息"的块，**直接踩在验收标准 ② 上**。
   */
  let format = detectFormat(filename, mime);
  if (!hasBuffer && format === 'unsupported') {
    // 手里已经有文本，总能按纯文本索引：识别不出格式不算错误
    format = 'text';
  }

  if (format === 'unsupported') {
    const e = new Error(
      '不支持的文档格式：' + (extOf(filename) ? '.' + extOf(filename) : (mime || '未知类型'))
      + '（当前支持 ' + parserCapabilities().nativeExtensions.concat(['pdf', 'docx', 'xlsx', 'pptx']).join(' / ') + '）'
    );
    e.code = 'unsupported_format';
    throw e;
  }

  const buf = hasBuffer
    ? (Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer))
    : Buffer.from(String(input.text == null ? '' : input.text), 'utf8');

  /**
   * 声明是纯文本、但内容明显是 Markdown（有 ATX 标题或围栏代码块）→ 按 Markdown 切。
   * 粘贴进来的内容没有扩展名可用，这是拿到标题定位的唯一途径。
   * 判定结果会写进 warnings：**自动判定必须可审计，不能悄悄改行为**。
   */
  const extraWarnings = [];
  if (format === 'text' && looksLikeMarkdown(buf.toString('utf8'))) {
    format = 'markdown';
    extraWarnings.push('内容识别为 Markdown：已按标题层级切分（正文里的 # 标记不再作为原文保留），引用可定位到章节。');
  }

  const out = (() => {
    switch (format) {
      case 'markdown': return { ...parseText(buf, { filename, markdown: true }), degraded: false };
      case 'text': return { ...parseText(buf, { filename, markdown: false }), degraded: false };
      case 'csv': return { ...parseCsv(buf, { filename }), degraded: false };
      case 'json': return { ...parseJson(buf, { filename }), degraded: false };
      case 'html': return { ...parseHtml(buf, { filename }), degraded: false };
      case 'pdf': return parsePdf(buf, { filename });
      case 'office': return parseOffice(buf, { filename });
      default: {
        const e = new Error('内部错误：未处理的格式分支 ' + format);
        e.code = 'internal';
        throw e;
      }
    }
  })();

  if (!extraWarnings.length) return out;
  return { ...out, warnings: [...(out.warnings || []), ...extraWarnings] };
}
