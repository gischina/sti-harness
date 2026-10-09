/**
 * 最小日志器。零依赖。
 *
 * 为什么要自己写：不引第三方（如 pino），而日志格式需要在
 * `--check` 的纯文本输出里保持可读、可直接粘贴给管理员。
 *
 * 落盘与轮转（2026-10 评审 P1-6）：
 *   · 每条日志除控制台外，追加写入 `<data>/logs/runtime.log`；
 *   · 文件达到大小上限（默认 10MB）自动轮转：runtime.log → .1 → .2 …
 *     保留最近若干份（默认 5），旧的最末份删除 —— 长期运行日志不再无界增长；
 *   · 文件流懒初始化（本模块被 import 得很早，数据目录此时可能还没建）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './paths.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let current = LEVELS[process.env.STI_LOG_LEVEL || 'info'] ?? LEVELS.info;

export function setLevel(name) {
  if (LEVELS[name] != null) current = LEVELS[name];
}

const LOG_FILE = path.join(LOG_DIR, 'runtime.log');
/** 单文件大小上限与保留份数 —— 运维不需要记住名字，给了环境变量就覆盖 */
const MAX_BYTES = Number(process.env.STI_LOG_MAX_BYTES) > 0
  ? Number(process.env.STI_LOG_MAX_BYTES) : 10 * 1024 * 1024;
const KEEP = Number(process.env.STI_LOG_KEEP) > 0 ? Number(process.env.STI_LOG_KEEP) : 5;

// ── 文件 sink（懒初始化；出错一律吞掉：日志能力绝不能反过来影响业务）────
let stream = null;
let bytes = 0;
let inited = false;

function openSink() {
  inited = true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try { bytes = Number(fs.statSync(LOG_FILE).size) || 0; } catch { bytes = 0; }
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    stream.on('error', () => { /* 写盘失败静默：控制台仍在输出 */ });
  } catch { stream = null; }
}

function rotate() {
  try { stream && stream.end(); } catch { /* ignore */ }
  try { fs.rmSync(LOG_FILE + '.' + KEEP, { force: true }); } catch { /* ignore */ }
  for (let i = KEEP - 1; i >= 1; i--) {
    try {
      if (fs.existsSync(LOG_FILE + '.' + i)) fs.renameSync(LOG_FILE + '.' + i, LOG_FILE + '.' + (i + 1));
    } catch { /* 某一份轮转失败不阻塞其余 */ }
  }
  try { if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch { /* ignore */ }
  bytes = 0;
  try {
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    stream.on('error', () => { /* ignore */ });
  } catch { stream = null; }
}

function writeFile(text) {
  try {
    if (!inited) openSink();
    if (!stream) return;
    const len = Buffer.byteLength(text);
    // 当前文件非空且加上这条会超限 → 先轮转再写
    if (bytes > 0 && bytes + len > MAX_BYTES) rotate();
    if (stream) {
      stream.write(text);
      bytes = bytes + len <= MAX_BYTES ? bytes + len : len;
    }
  } catch { /* 落盘失败不影响控制台输出与业务 */ }
}

function ts() {
  // 本地时间 YYYY-MM-DD HH:MM:SS —— 跨天运行的日志必须能区分日期
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function emit(level, args) {
  if (LEVELS[level] < current) return;
  const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
  const line = '[' + ts() + ' ' + tag + ']';
  if (level === 'error') console.error(line, ...args);
  else if (level === 'warn') console.error(line, ...args);
  else console.log(line, ...args);
  // 落盘的是拼好的整行（控制台带格式，文件保持纯文本可读）
  writeFile(line + ' ' + args.map((a) => (a instanceof Error ? (a.stack || a.message) : String(a))).join(' ') + '\n');
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};

/** 供 --check 使用：直出纯文本，不带时间戳/标签，方便对方整段复制。 */
export function plain(line = '') {
  console.log(line);
}
