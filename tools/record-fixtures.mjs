/**
 * fixtures 录制工具 —— 把**真实上游事件流**脱敏后固化成回归数据。
 *
 * 为什么需要它（docs/roadmap.md「M0 缺口」）：
 *   `upstream-contract.mjs` 只能看到**类型定义**里的字段名；真实的会话日志里还有
 *   插件自有事件（`session/title`、`sandbox/mode`、`workspace/changes`…），
 *   以及"字段名没变但**结构变了**"这类破坏（例如 `content` 从字符串变成块数组）。
 *   这些只有拿真实事件流才能发现 —— 这就是 fixtures 的全部价值。
 *
 * 数据来源：上游自己的会话日志（**不需要浏览器令牌**）
 *   `<DSH_HOME 或 ~/.dsh>/sessions/<projectKey>/<sessionId>/session.vN.jsonl.zstd`
 *   文件是**拼接的 zstd 帧容器**：首帧是 header 行，其后每帧一个事件批次。
 *
 * 脱敏策略（可审计，脚本会把它写进 fixture 的 meta.redaction）：
 *   · 保留：事件信封（type/seq/time/surfaceOp）、数字与布尔、数组长度与元素结构
 *   · 保留：**枚举型**键（type/kind/role/status/reason/preset/mode/policy/provider/model/
 *           name/isError/origin/agentPreset/lang/operation/shape/form/version）
 *   · 替换：以 id 结尾的键 → `<id>`；其余字符串 → `<text:N>`（N 为原字符数）
 *   即：**结构 100% 真实，内容 0 泄漏**。字符串长度保留，因此"字段还在但变成空串"也能测出来。
 *
 * 用法：
 *   node tools/record-fixtures.mjs --list                 # 列出本机可用的会话日志
 *   node tools/record-fixtures.mjs                        # 录制（自动挑最大的一个会话）
 *   node tools/record-fixtures.mjs --from <路径>           # 指定日志文件
 *   node tools/record-fixtures.mjs --per-type 3 --max 300   # 调整裁剪
 *
 * 末行输出 `DONE fails=N`。本机没有会话日志 → SKIP（明确说明，不伪装成成功）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import '../app/util/quiet-warnings.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDshClient } from '../app/kernel/dsh-provider/client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, '..', 'app', 'kernel', 'fixtures');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const wantList = args.includes('--list');
const fromPath = opt('from', null);
const perType = Number(opt('per-type', 2));
const maxRows = Number(opt('max', 200));

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

function line(s = '') { console.log(s); }

/** 会话日志根目录：优先 DSH_HOME，其次 ~/.dsh */
function sessionRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'sessions');
}

/** 递归找所有会话日志文件 */
function findLogs(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^session\.v\d+\.jsonl\.zstd$/.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * 解压「拼接 zstd 帧容器」。
 * 不能直接用流式解压器：帧之间不是连续的 zstd 流（实测会报 Unknown frame descriptor）。
 * 按魔数切帧、逐帧解压，个别 torn 帧（写入中断）跳过并如实计数。
 */
function decompressFrames(buf) {
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { starts.push(i); i += 4; }
  if (!starts.length) return { text: '', frames: 0, torn: 0, note: '未找到任何 zstd 帧魔数' };
  starts.push(buf.length);
  const parts = [];
  let torn = 0;
  for (let k = 0; k < starts.length - 1; k++) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1])));
    } catch {
      torn++;
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: starts.length - 1, torn };
}

// ── 脱敏 ──────────────────────────────────────────────────────────────

/** 这些键的值是**枚举/标识符**，不承载用户内容，保留原值（否则 fixture 测不出映射） */
const KEEP_ENUM_KEYS = new Set([
  'type', 'kind', 'role', 'status', 'surfaceOp', 'origin', 'format',
  'preset', 'mode', 'policy', 'provider', 'model',
  'isError', 'isSeeded', 'delegationDepth', 'agentPreset',
  'lang', 'operation', 'shape', 'form', 'version', 'versionNumber',
]);

const isIdKey = (k) => /^(id|.*Id|.*_id)$/.test(k);

function redactValue(v, key) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;

  if (typeof v === 'string') {
    if (KEEP_ENUM_KEYS.has(key)) return v;
    if (isIdKey(key)) return '<id>';
    return '<text:' + v.length + '>';
  }

  if (Array.isArray(v)) return v.map((x) => redactValue(x, key));

  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactValue(val, k);
    return out;
  }
  return '<' + typeof v + '>';
}

/** 事件级脱敏：信封照旧（seq/time 是必要的时序信息），只脱 data 内与 message 内的内容 */
function redactEvent(ev) {
  const out = {};
  for (const [k, v] of Object.entries(ev)) {
    if (k === 'data' || k === 'message' || k === 'error' || k === 'source' || k === 'stream'
      || k === 'meta' || k === 'header' || k === 'reason') {
      out[k] = redactValue(v, k);
    } else {
      out[k] = redactValue(v, k);
    }
  }
  return out;
}

/** 挑代表性样本：保证第一个完整 turn 的**开头一段**连续事件，再补齐每种类型的样本 */
function sample(rows, { perTypeCount, limit }) {
  const keep = new Set();

  // 1) 第一个 turn 的开头一段（形成可断言的连续序列）
  const start = rows.findIndex((r) => r.type === 'turn/start');
  if (start >= 0) {
    for (let i = start; i < Math.min(start + 30, rows.length); i++) keep.add(i);
  }
  // 2) 每种类型的前 N 条
  const counts = new Map();
  for (let i = 0; i < rows.length; i++) {
    if (keep.has(i)) continue;
    const t = rows[i].type;
    const c = counts.get(t) || 0;
    if (c < perTypeCount) { keep.add(i); counts.set(t, c + 1); }
  }
  const idx = [...keep].sort((a, b) => a - b);
  return { rows: idx.slice(0, limit).map((i) => rows[i]), picked: Math.min(idx.length, limit), totalKept: idx.length };
}

// ── 主流程 ────────────────────────────────────────────────────────────

line('');
line('STI HARNESS fixtures 录制');
line('='.repeat(64));

const root = sessionRoot();
const logs = findLogs(root);

line('');
line('会话日志根目录：' + root);

if (!logs.length) {
  line('  未找到任何 session.vN.jsonl.zstd');
  line('');
  line('  SKIP：本机没有可用的上游会话日志，无法录制真实事件流。');
  line('        这不是"通过"——fixtures 缺口仍然存在（见 docs/roadmap.md「M0 缺口」）。');
  line('        先用上游跑一轮会话（`dsh` 或 `dsh web`），日志会自动写到上面这个目录。');
  line('');
  line('='.repeat(64));
  line('用例 0 个｜失败 0 个｜跳过 1 个');
  line('DONE fails=0 skipped=1');
  process.exitCode = 0;
} else if (wantList) {
  const withSize = logs.map((f) => ({ f, size: fs.statSync(f).size })).sort((a, b) => b.size - a.size);
  line('');
  line('可用会话日志（按大小倒序）：');
  for (const { f, size } of withSize) {
    line('  ' + String(size).padStart(9) + ' B  ' + path.relative(root, f));
  }
  line('');
  line('DONE fails=0');
  process.exitCode = 0;
} else {
  // 选目标：显式指定 > 最大的
  let target = fromPath ? path.resolve(fromPath) : null;
  if (target && !fs.existsSync(target)) {
    line('');
    line('  ✗ --from 指定的文件不存在：' + target);
    line('DONE fails=1');
    process.exitCode = 1;
    process.exit();
  }
  if (!target) {
    target = logs.map((f) => ({ f, size: fs.statSync(f).size })).sort((a, b) => b.size - a.size)[0].f;
  }

  const buf = fs.readFileSync(target);
  const { text, frames, torn } = decompressFrames(buf);
  const rows = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

  const header = rows.find((r) => r.type === 'session') || null;
  const events = rows.filter((r) => r.type !== 'session');

  const observedTypes = [...new Set(events.map((r) => String(r.type)))];
  const typeCounts = {};
  for (const r of events) typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;

  line('  已选：' + path.relative(root, target));
  line('  文件 ' + buf.length + ' B｜zstd 帧 ' + frames + (torn ? '（含 ' + torn + ' 个 torn 帧已跳过）' : '')
    + '｜明文 ' + text.length + ' B｜事件 ' + events.length + ' 条｜类型 ' + observedTypes.length + ' 种');

  // 上游包版本（写进 meta，供"这条 fixture 属于哪个上游"的判定）
  const client = createDshClient({ origin: 'http://127.0.0.1:1/' });
  const hit = client.discover().find((f) => f.packageDir);
  const upstreamVersion = hit ? hit.version : '';
  if (!upstreamVersion) {
    line('  ⚠ 未能读上游包版本 —— fixture 里该字段会留空（不影响回归，但不利于溯源）');
  }

  const s = sample(events, { perTypeCount: perType, limit: maxRows });
  const redacted = s.rows.map(redactEvent);

  const fixture = {
    meta: {
      note: '由 tools/record-fixtures.mjs 录制并脱敏。请勿手改：脱敏规则在脚本里，手改会让"真实结构"这一价值失真。',
      source: 'dsh session log (concatenated zstd frame container)',
      upstreamPackage: '@deepseek-ai/dsh',
      upstreamVersion,
      sessionFormatVersion: header ? header.version : null,
      sourceSha256_12: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12),
      recordedAt: new Date().toISOString(),
      sourceEventsTotal: events.length,
      recordedEvents: redacted.length,
      observedTypes,
      typeCounts,
      redaction: [
        '保留：事件信封（type/seq/time/surfaceOp）、所有数字与布尔、数组长度与元素结构',
        '保留：枚举型键的值（type/kind/role/status/reason/preset/mode/policy/provider/model/name/isError/origin/agentPreset/lang/operation/shape/form/version）',
        '替换：id 类键 → "<id>"；其余字符串 → "<text:N>"（N=原字符数，保留长度信息）',
        '未保留：原始文件路径（只存 sha256 前 12 位，避免泄漏本机目录结构）',
      ],
    },
    events: redacted,
  };

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const base = 'dsh-' + (upstreamVersion || 'unknown') + '-session.json';
  const outFile = path.join(FIXTURE_DIR, base);
  fs.writeFileSync(outFile, JSON.stringify(fixture, null, 2) + '\n', 'utf8');

  line('');
  line('  已写入：' + path.relative(path.join(HERE, '..'), outFile)
    + '（' + fs.statSync(outFile).size + ' B，' + redacted.length + '/' + events.length + ' 条事件）');
  line('  覆盖的事件类型：' + observedTypes.join(' '));
  line('');
  line('  下一步：`node tools/test-core.mjs` —— 它会自动把 fixtures 目录纳入回归。');
  line('         若有用例因"命中未核实规则"而失败，说明该规则的字段名需要按真实形状修正。');
  line('');
  line('='.repeat(64));
  line('用例 1 个｜失败 0 个');
  line('DONE fails=0');
  process.exitCode = 0;
}
