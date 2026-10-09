/**
 * 会话日志读取 —— 外部模式下**事件历史的真实来源**。
 *
 * 为什么需要它（P0-A 实测结论）：
 *   上游把一轮对话的完整事件流写在**追加式日志文件**里：
 *     <DSH_HOME>/sessions/<cwd 派生键>/<sessionId>/session.v<N>.jsonl.zstd
 *   而"从事件流读历史"的另一条路（`session/follow`）是 WebSocket，
 *   服务端要消费它就得自己解 WS 帧 —— 那是 P0-C 的活。
 *
 *   在 WS 消费落地之前，直接读这个日志文件是**同等真实**的数据来源：
 *   它是上游自己写的 append-only 日志，不是我们伪造的第二份数据。
 *   本项目"不落第二份数据"的原则针对的是**我们**不去编，不是禁用上游的真实产物。
 *
 * 文件格式：拼接的 zstd 帧容器（与 tools/record-fixtures.mjs 读的是同一种）。
 *   · 不能当连续 zstd 流解 —— 帧之间不连续，流式解压器会报 Unknown frame descriptor。
 *   · 按魔数 `28 B5 2F FD` 切帧、逐帧解压。
 *   · 写入中的**尾帧可能是 torn**（不完整），跳过并如实计数 —— 下一轮轮询会补上。
 *
 * ⚠️ 本文件位于 dsh-provider/ 内，是上游存储布局的合法归属地。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

export function sessionsRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'sessions');
}

/**
 * cwd → 上游的 projectKey。
 * 实测：`C:\Users\lw\AppData\Local\Temp\x` → `--C-Users-lw-AppData-Local-Temp-x--`
 * 即把 `:` `\` `/` 的**连续串**压成一个 `-`，两侧各包 `--`。
 */
export function projectKeyOf(cwd) {
  if (!cwd) return '';
  const body = String(cwd).replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, '');
  return '--' + body + '--';
}

/** 在某个项目目录下找该会话的日志文件（同名可能有多个版本，取版本号最大的） */
function findInProject(projDir, sessionId) {
  const dir = path.join(projDir, sessionId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const logs = names.filter((f) => /^session\.v(\d+)\.jsonl\.zstd$/.test(f))
    .sort((a, b) => Number(/(\d+)/.exec(b)[1]) - Number(/(\d+)/.exec(a)[1]));
  return logs.length ? path.join(dir, logs[0]) : null;
}

/**
 * 定位会话日志文件。
 * 优先用 cwd 派生的 projectKey 直接命中；否则遍历所有项目目录找同名会话
 * （会话 id 全局唯一，遍历是可靠的兜底，且只在快路径未命中时才做）。
 */
export function locateSessionLog(sessionId, cwd = '') {
  if (!sessionId) return null;
  const root = sessionsRoot();

  const key = projectKeyOf(cwd);
  if (key) {
    const hit = findInProject(path.join(root, key), sessionId);
    if (hit) return hit;
  }
  try {
    for (const proj of fs.readdirSync(root)) {
      const hit = findInProject(path.join(root, proj), sessionId);
      if (hit) return hit;
    }
  } catch { /* 目录不存在就是没有 */ }
  return null;
}

/**
 * 解压「拼接 zstd 帧容器」并逐行解析 JSONL。
 * @returns {{rows:object[], frames:number, torn:number, bytes:number, note:string}}
 */
export function readLogRows(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) {
    return { rows: [], frames: 0, torn: 0, bytes: 0, note: '读取失败：' + e.message };
  }
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { starts.push(i); i += 4; }
  if (!starts.length) return { rows: [], frames: 0, torn: 0, bytes: buf.length, note: '未找到 zstd 帧魔数（文件可能刚创建还未写入）' };
  starts.push(buf.length);

  const parts = [];
  let torn = 0;
  for (let k = 0; k < starts.length - 1; k++) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1]))); }
    catch { torn++; }   // 尾帧写入中 → 下一轮再读
  }
  const text = Buffer.concat(parts).toString('utf8');
  const rows = [];
  for (const l of text.split('\n')) {
    const s = l.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* 截断的最后一行，跳过 */ }
  }
  return { rows, frames: starts.length - 1, torn, bytes: buf.length, note: '' };
}

/**
 * 会话日志句柄：带"文件大小未变则不重读"的缓存。
 * 一轮对话会产生多次轮询，缓存把重复解压省掉。
 */
export function openSessionLog(sessionId, cwd = '') {
  let file = locateSessionLog(sessionId, cwd);
  let cache = { size: -1, rows: [], meta: null };

  /** 文件还没出现时反复重定位 —— 上游是"先建会话、稍后才写日志"，一次没找到不等于永远没有 */
  function ensureFile() {
    if (file) return file;
    file = locateSessionLog(sessionId, cwd);
    return file;
  }

  return {
    get file() { return file; },
    get available() { return !!ensureFile(); },

    /** 读全部行（尺码未变则返回缓存） */
    read() {
      const f = ensureFile();
      if (!f) return { rows: [], note: '未找到会话日志文件（上游可能尚未写入）' };
      let size = -1;
      try { size = fs.statSync(f).size; } catch { file = null; return { rows: [], note: '日志文件已消失，下次重定位' }; }
      if (size === cache.size && cache.meta) return { rows: cache.rows, ...cache.meta };
      const r = readLogRows(f);
      cache = { size, rows: r.rows, meta: { frames: r.frames, torn: r.torn, bytes: r.bytes, note: r.note } };
      return { rows: cache.rows, ...cache.meta };
    },

    /** 只取 seq > afterSeq 的行（顺序按 seq 升序） */
    readAfter(afterSeq = 0) {
      const { rows, ...meta } = this.read();
      const out = rows
        .filter((r) => r && typeof r.seq === 'number' && r.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq);
      return { rows: out, ...meta };
    },

    /**
     * 日志当前的**最大 seq**（"日志头"）。
     * 用途：提交新回合前记下它，之后就能精确取出"这一轮新增的事件"。
     * ⚠️ 不要拿平台库里的 seq 当游标 —— 那是本项目自己编的号，与上游日志的 seq 是两套。
     */
    headSeq() {
      const { rows } = this.read();
      let max = 0;
      for (const r of rows) if (r && typeof r.seq === 'number' && r.seq > max) max = r.seq;
      return max;
    },

    /** 该会话日志里出现过的事件类型（诊断用） */
    types() {
      const { rows } = this.read();
      return [...new Set(rows.map((r) => String(r && r.type)))];
    },
  };
}

export default { sessionsRoot, projectKeyOf, locateSessionLog, readLogRows, openSessionLog };
