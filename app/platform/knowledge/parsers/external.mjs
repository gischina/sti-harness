/**
 * 外部命令解析适配器：PDF / Office 文档。
 *
 * ⚠️ 本文件的**核心纪律是「诚实降级」**：
 *   · 探测不到 `pdftotext` / `libreoffice` 时，**绝不**把二进制字节当文本存进索引
 *     （那会产出一堆乱码分块，而且看起来"导入成功了"）；
 *   · 一律抛出带 `code='parser_unavailable'` 的错误，由调用方把文档置为 `failed`
 *     并把**原始原因**写进 documents.error，界面直接显示「缺哪个命令、怎么装」。
 *
 * 为什么用**同步** exec：这些解析器只在 worker 线程里被调用。
 * 同步阻塞只会占住那一个 worker（这正是把解析放进 worker 池的目的），
 * 主线程的事件循环不受影响。若放在主线程，LibreOffice 动辄几秒的启动会把服务卡住。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseText } from './text.mjs';
import { parseCsv } from './csv.mjs';
import { normSpace } from './util.mjs';

const PROBE_TIMEOUT = 8000;
const PDF_TIMEOUT = 60_000;
const OFFICE_TIMEOUT = 180_000;

/** 外部工具不可用（区别于"解析出错了"） */
export class ParserUnavailableError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ParserUnavailableError';
    this.code = 'parser_unavailable';
    this.detail = detail;
  }
}

/** 解析过程失败（工具在，但退出码非 0 / 输出不可用） */
export class ParserFailedError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ParserFailedError';
    this.code = 'parse_failed';
    this.detail = detail;
  }
}

/* ── 工具探测 ────────────────────────────────────────────────────── */

/**
 * 在 PATH 上找命令，并跑一次版本探测确认它**真的能执行**。
 * 只看 `which` 的结果不够：Windows 上常见「PATH 里有个同名占位文件」。
 */
function probeCommand(candidates, versionArgs) {
  for (const cmd of candidates) {
    try {
      const out = execFileSync(cmd, versionArgs, {
        timeout: PROBE_TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      const text = normSpace(String(out || ''));
      return { available: true, command: cmd, version: text.split('\n')[0].slice(0, 120) };
    } catch (e) {
      // ENOENT = 没这个命令，继续试下一个候选
      if (e && (e.code === 'ENOENT' || /not recognized|not found/i.test(String(e.message)))) continue;
      // 命令存在但退出码非 0（pdftotext -v 就是往 stderr 写并返回 0/1）——看有没有输出
      const out = String((e && (e.stdout || e.stderr)) || '').trim();
      if (out) return { available: true, command: cmd, version: out.split('\n')[0].slice(0, 120) };
      return { available: false, command: cmd, error: short(e) };
    }
  }
  return { available: false, command: null, error: '未在 PATH 中找到：' + candidates.join(' / ') };
}

/** LibreOffice 不一定在 PATH 上；从环境变量推导常见安装位置（不写死盘符/用户名） */
function officeCandidates() {
  const list = [];
  if (process.env.STI_SOFFICE) list.push(process.env.STI_SOFFICE);
  list.push('soffice', 'libreoffice');
  const pf = process.env['ProgramFiles'] || process.env['PROGRAMFILES'];
  const pf86 = process.env['ProgramFiles(x86)'] || process.env['PROGRAMFILES(X86)'];
  for (const base of [pf, pf86]) {
    if (!base) continue;
    list.push(path.join(base, 'LibreOffice', 'program', 'soffice.exe'));
  }
  list.push('/usr/bin/soffice', '/usr/bin/libreoffice', '/opt/libreoffice/program/soffice');
  list.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  return [...new Set(list)];
}

let _probeCache = null;

/**
 * 实测报告外部解析能力。**结果会缓存**（探测要起子进程，不能每个文档都跑一次）。
 * @param {{refresh?:boolean}} opts
 */
export function probeExternalTools(opts = {}) {
  if (_probeCache && !opts.refresh) return _probeCache;
  const pdftotext = probeCommand(['pdftotext'], ['-v']);
  const office = probeCommand(officeCandidates(), ['--version']);
  _probeCache = {
    pdftotext: { ...pdftotext, provides: ['pdf'], hint: '安装 poppler-utils（Debian/Ubuntu: apt install poppler-utils；macOS: brew install poppler；Windows: 下载 poppler 并把 bin 加进 PATH）' },
    office: { ...office, provides: ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf'], hint: '安装 LibreOffice（或设置 STI_SOFFICE 指向 soffice 可执行文件）' },
  };
  return _probeCache;
}

function short(e) {
  const s = String((e && (e.message || e.stderr || e)) || '').trim();
  return s.split('\n')[0].slice(0, 200);
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-parse-'));
  try {
    return fn(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
  }
}

/* ── PDF ─────────────────────────────────────────────────────────── */

/**
 * 用 pdftotext 抽取 PDF 文本，按分页符切成 blocks（带 loc.page，引用才精确）。
 * @param {Buffer} buffer
 * @param {{filename?:string}} opts
 */
export function parsePdf(buffer, opts = {}) {
  const tools = probeExternalTools();
  if (!tools.pdftotext.available) {
    throw new ParserUnavailableError(
      '本机没有可用的 pdftotext，无法解析 PDF（不会把二进制当文本索引）。' + tools.pdftotext.hint,
      { tool: 'pdftotext', probe: tools.pdftotext }
    );
  }

  return withTempDir((dir) => {
    const src = path.join(dir, 'in.pdf');
    fs.writeFileSync(src, buffer);
    let stdout;
    try {
      stdout = execFileSync(tools.pdftotext.command, ['-layout', '-enc', 'UTF-8', '-eol', 'unix', src, '-'], {
        timeout: PDF_TIMEOUT, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      });
    } catch (e) {
      throw new ParserFailedError('pdftotext 执行失败：' + short(e), { tool: 'pdftotext', exitCode: e.status });
    }
    const pages = String(stdout).split('\f');
    const blocks = [];
    let pageNo = 0;
    for (const p of pages) {
      const t = String(p).replace(/\s+$/, '');
      pageNo++;
      if (!t.trim()) continue;
      // 页内再按空行分段，保持页号
      for (const para of t.split(/\n{2,}/)) {
        const text = normSpace(para.replace(/\n+/g, ' '));
        if (text) blocks.push({ text, kind: 'text', loc: { page: pageNo } });
      }
    }
    const text = blocks.map((b) => b.text).join('\n\n');
    const warnings = [];
    if (!text.trim()) {
      warnings.push('pdftotext 未能抽取到任何文本：该 PDF 可能是扫描件（图片），需要 OCR 才能检索');
    }
    return {
      text,
      blocks,
      meta: { format: 'pdf', pages: pages.length, title: normSpace(String(opts.filename || '')) },
      parser: 'pdf:pdftotext',
      degraded: false,
      warnings,
    };
  });
}

/* ── Office（docx / xlsx / pptx / odt / ods / rtf） ───────────────── */

const SPREADSHEET_EXT = new Set(['xlsx', 'xls', 'ods', 'csv']);

/**
 * 用 LibreOffice headless 转成纯文本 / CSV，再交给本地的 text / csv 解析器。
 * ⚠️ 每个进程用**独立的 UserInstallation profile**：LibreOffice 不允许
 * 两个实例共用同一个 profile，共用会静默失败（退出码 0 但没有输出文件）。
 */
export function parseOffice(buffer, opts = {}) {
  const tools = probeExternalTools();
  if (!tools.office.available) {
    throw new ParserUnavailableError(
      '本机没有可用的 LibreOffice，无法解析该 Office 文档（不会把二进制当文本索引）。' + tools.office.hint,
      { tool: 'soffice', probe: tools.office }
    );
  }

  const filename = String(opts.filename || 'input.bin');
  const ext = (path.extname(filename).slice(1) || 'bin').toLowerCase();
  const isSheet = SPREADSHEET_EXT.has(ext);

  return withTempDir((dir) => {
    const src = path.join(dir, 'in.' + ext);
    fs.writeFileSync(src, buffer);
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const profile = path.join(dir, 'profile');

    const convertTo = isSheet ? 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true'
      : 'txt:Text (encoded):UTF8';
    const args = [
      '--headless', '--norestore', '--nolockcheck', '--nodefault',
      '-env:UserInstallation=' + pathToFileURL(profile).href,
      '--convert-to', convertTo,
      '--outdir', outDir,
      src,
    ];
    try {
      execFileSync(tools.office.command, args, {
        timeout: OFFICE_TIMEOUT, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      throw new ParserFailedError('LibreOffice 转换失败：' + short(e), { tool: 'soffice', exitCode: e.status });
    }

    const produced = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
    if (!produced.length) {
      throw new ParserFailedError(
        'LibreOffice 未产出任何文件（通常是文档损坏或格式不被支持）。被转换的文件：' + filename,
        { tool: 'soffice', produced: 0 }
      );
    }
    const outFile = path.join(outDir, produced[0]);
    const buf = fs.readFileSync(outFile);

    const inner = isSheet
      ? parseCsv(buf, { filename: produced[0] })
      : parseText(buf, { filename: 'converted.txt', markdown: false });

    return {
      ...inner,
      meta: { ...inner.meta, format: ext, convertedBy: 'libreoffice', source: filename },
      parser: ext + ':libreoffice',
      degraded: false,
      warnings: inner.warnings.concat(isSheet ? [] : []),
    };
  });
}
