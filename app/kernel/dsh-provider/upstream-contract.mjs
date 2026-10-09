/**
 * 上游契约快照 —— 在**没有 fixtures** 时，最接近 fixtures 的东西。
 *
 * 背景：M0 的 fixtures 回归因本机上游要求浏览器会话鉴权、拿不到真实运行事件流而未能交付
 * （见 docs/roadmap.md「M0 缺口」）。fixtures 用「真实运行事件流」钉住映射；本模块改用
 * 「上游**类型定义源码**」钉住映射。
 *
 * 它更弱：不是运行数据，看不到运行时的形状漂移（比如某字段在某分支上不再赋值）。
 * 但它显著强于纯猜测，且能自动发现**改名**这一类最隐蔽的破坏性变更（feasibility §6.3）——
 * 而这正是 fixtures 要防的主要问题。两者的关系：
 *
 *   fixtures（运行事件流）─── 强，覆盖运行时形状；需要可认证的上游
 *   本模块（类型定义） ────── 弱一档，覆盖**类型契约**；只需装了上游包
 *   别名表里的猜测   ────── 最弱，只能覆盖"我们以为的形状"
 *
 * 因此两者是**叠加**关系，不是替代关系：拿到 fixtures 后本模块继续留着，
 * 它管"类型契约变了没"，fixtures 管"运行时真的这么发吗"。
 *
 * 覆盖内容：
 *   · SessionEventMap 的事件类型名与各自字段名（会话日志的权威词汇表）
 *   · TokenUsage 的字段名（assistant/message.usage 的形状）
 *   · TurnTokenUsage 的字段名（按 turn 折叠的聚合用量）
 *
 * 快照入库为 upstream-contract.snapshot.json；上游升级后跑
 * `node tools/snapshot-upstream-contract.mjs` 即可看出差异。
 * 快照只记录**包内相对路径**，不写绝对路径（可移植、不泄漏本机目录结构）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 需要读取的上游子包与文件（相对包根，便于跨机复现） */
export const CONTRACT_SOURCES = {
  sessionTypes: { pkg: 'dsh-session', rel: 'lib/types/types.d.ts', what: 'SessionEventMap（事件类型与字段）' },
  llmTypes: { pkg: 'dsh-llm', rel: 'lib/types/types.d.ts', what: 'TokenUsage（单次模型调用的用量）' },
  tokenMeterTurnUsage: { pkg: 'dsh-token-meter', rel: 'lib/types/turn-usage.d.ts', what: 'TurnTokenUsage（按 turn 折叠的聚合用量）' },
};

/** 剥掉注释，避免注释里的 `字段：` 被误当成成员 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\w"'`])\/\/[^\n]*/gm, '$1');
}

/** 取出 `interface X {` / `type X = {` 的花括号体（按花括号配对，不依赖缩进） */
function extractBraceBody(src, name) {
  const re = new RegExp('(?:interface|type)\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[^{;]*\\{');
  const m = re.exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return null;
}

/**
 * 取「最外层」成员名：先量出每个候选成员的缩进，再只保留缩进最小的那一组。
 * 这样 `'turn/start': { turn: number }` 只会取出 `turn/start`，不会把 `turn` 也当成同级成员。
 * 支持 `readonly` / `public` 等成员修饰符（上游的 TurnTokenUsage 大量使用 READONLY）。
 */
function outerMembers(body) {
  // 修饰符写成字面量的一部分（不用动态拼接），这样 m.index 仍是行首，调用方的切片索引不会错位。
  const re = /^([ \t]*)(?:(?:readonly|public|private|protected|static|declare|abstract)[ \t]+)*('(?:[^'\\]|\\.)*'|[A-Za-z_$][\w$]*)[ \t]*(\??)[ \t]*:/gm;
  const found = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    found.push({ indent: m[1].replace(/\t/g, '  ').length, name: m[2].replace(/^'|'$/g, ''), optional: m[3] === '?', at: m.index, rawStart: m.index });
  }
  if (!found.length) return [];
  const min = Math.min(...found.map((f) => f.indent));
  return found.filter((f) => f.indent === min).map((f, i, arr) => ({ ...f, nextAt: i + 1 < arr.length ? arr[i + 1].at : body.length }));
}

/** 把一个对象体解析成 { key: [子字段名] }；值是别名引用时记为 '@别名'（让"引用了别的类型"一眼可见） */
function parseMemberMap(body) {
  const out = {};
  const members = outerMembers(body);
  for (const mem of members) {
    const seg = body.slice(mem.at, mem.nextAt);
    const braceAt = seg.indexOf('{');
    if (braceAt < 0) {
      // 别名引用（如 `user/message: UserMessage;`）—— 记录引用名，而不是伪装成"没有字段"
      const afterColon = seg.slice(seg.indexOf(':') + 1);
      const ref = /^[ \t]*([A-Za-z_$][\w$]*)/.exec(afterColon);
      out[mem.name] = ref ? ['@' + ref[1]] : [];
      continue;
    }
    const sub = seg.slice(braceAt + 1);
    // 从成员名之后重新做一次花括号配对，拿到该成员的值体
    let depth = 0;
    let end = -1;
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] === '{') depth++;
      else if (seg[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const valueBody = end > braceAt ? seg.slice(braceAt + 1, end) : '';
    out[mem.name] = outerMembers(valueBody).map((f) => f.name + (f.optional ? '?' : ''));
  }
  return out;
}

/** 解析平铺接口的字段名（带 ? 后缀标记可选） */
function parseFields(body) {
  return outerMembers(body).map((f) => f.name + (f.optional ? '?' : ''));
}

/** 在 dsh 包及其上层 node_modules 中定位一个 @deepseek-ai 子包 */
export function resolveSubPackage(dshPkgDir, name) {
  const bases = [path.join(dshPkgDir, 'node_modules', '@deepseek-ai', name)];
  let cur = dshPkgDir;
  for (let i = 0; i < 6; i++) {
    bases.push(path.join(cur, 'node_modules', '@deepseek-ai', name));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const b of bases) {
    try {
      if (fs.existsSync(path.join(b, 'package.json'))) return b;
    } catch { /* 换下一个 */ }
  }
  return null;
}

function readUpstreamVersion(dshPkgDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dshPkgDir, 'package.json'), 'utf8'));
    return j.version || '';
  } catch {
    return '';
  }
}

/**
 * 从上游包源码提取契约快照。
 *
 * @param {string} dshPkgDir `@deepseek-ai/dsh` 包根目录（可由 client.discover() 得到）
 * @returns {{available:boolean, reason?:string, version?:string, sources?:object,
 *            sessionEventTypes?:object, tokenUsageFields?:string[], turnTokenUsageFields?:string[]}}
 */
export function extractUpstreamContract(dshPkgDir) {
  if (!dshPkgDir) return { available: false, reason: '未提供上游包目录' };
  let st = null;
  try { st = fs.statSync(dshPkgDir); } catch { /* 交给下面统一处理 */ }
  if (!st || !st.isDirectory()) return { available: false, reason: '上游包目录不存在：' + dshPkgDir };

  const sources = {};
  const missing = [];

  function load(key) {
    const spec = CONTRACT_SOURCES[key];
    const dir = resolveSubPackage(dshPkgDir, spec.pkg);
    if (!dir) { missing.push(spec.pkg + '（未安装）'); return null; }
    const file = path.join(dir, spec.rel);
    try {
      sources[key] = '@deepseek-ai/' + spec.pkg + '/' + spec.rel;
      return stripComments(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      missing.push(spec.pkg + '/' + spec.rel + '（' + e.code + '）');
      sources[key] = '@deepseek-ai/' + spec.pkg + '/' + spec.rel + '（读取失败）';
      return null;
    }
  }

  const sessionSrc = load('sessionTypes');
  const llmSrc = load('llmTypes');
  const usageSrc = load('tokenMeterTurnUsage');

  const result = {
    available: true,
    version: readUpstreamVersion(dshPkgDir),
    sources,
    sessionEventTypes: {},
    tokenUsageFields: [],
    turnTokenUsageFields: [],
    missing,
  };

  if (sessionSrc) {
    const body = extractBraceBody(sessionSrc, 'SessionEventMap');
    if (body) result.sessionEventTypes = parseMemberMap(body);
  }
  if (llmSrc) {
    const body = extractBraceBody(llmSrc, 'TokenUsage');
    if (body) result.tokenUsageFields = parseFields(body);
  }
  if (usageSrc) {
    const body = extractBraceBody(usageSrc, 'TurnTokenUsage');
    if (body) result.turnTokenUsageFields = parseFields(body);
  }

  if (!Object.keys(result.sessionEventTypes).length && !result.tokenUsageFields.length) {
    return { available: false, reason: '读到了上游包但没能解析出任何契约（上游可能改了文件布局）', missing };
  }
  return result;
}

/** 与既有快照对比，返回逐项差异（改名/新增/删除/版本变化） */
export function diffContract(prev, next) {
  const changes = [];
  if (!prev || !next) return { ok: true, changes: [], note: '无可比对象' };

  if (prev.version !== next.version) {
    changes.push({ kind: 'version', item: '上游版本', before: prev.version, after: next.version });
  }

  const prevTypes = prev.sessionEventTypes || {};
  const nextTypes = next.sessionEventTypes || {};
  for (const k of Object.keys(prevTypes)) {
    if (!(k in nextTypes)) changes.push({ kind: 'removed', item: '事件类型 ' + k, before: Object.keys(prevTypes).length + ' 型', after: '已不存在' });
  }
  for (const k of Object.keys(nextTypes)) {
    if (!(k in prevTypes)) { changes.push({ kind: 'added', item: '事件类型 ' + k, before: '—', after: (nextTypes[k] || []).join(', ') }); continue; }
    const a = (prevTypes[k] || []).slice().sort().join(',');
    const b = (nextTypes[k] || []).slice().sort().join(',');
    if (a !== b) changes.push({ kind: 'fields', item: '事件 ' + k + ' 的字段', before: a, after: b });
  }

  for (const [label, key] of [['TokenUsage', 'tokenUsageFields'], ['TurnTokenUsage', 'turnTokenUsageFields']]) {
    const a = (prev[key] || []).slice().sort().join(',');
    const b = (next[key] || []).slice().sort().join(',');
    if (a !== b) changes.push({ kind: 'fields', item: label + ' 的字段', before: a, after: b });
  }

  return { ok: changes.length === 0, changes };
}

/** 快照文件读写。文件名固定，与工具脚本共用。 */
export const SNAPSHOT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'upstream-contract.snapshot.json');

export function readSnapshot(file = SNAPSHOT_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeSnapshot(snapshot, file = SNAPSHOT_FILE) {
  const stable = {
    _note: '由 tools/snapshot-upstream-contract.mjs 生成。请勿手改——手改会让"上游变了"这一信号失真。',
    version: snapshot.version,
    extractedAt: new Date().toISOString(),
    sources: snapshot.sources,
    sessionEventTypes: snapshot.sessionEventTypes,
    tokenUsageFields: snapshot.tokenUsageFields,
    turnTokenUsageFields: snapshot.turnTokenUsageFields,
  };
  fs.writeFileSync(file, JSON.stringify(stable, null, 2) + '\n', 'utf8');
  return file;
}

export const _internals = { stripComments, extractBraceBody, outerMembers, parseMemberMap, parseFields };
