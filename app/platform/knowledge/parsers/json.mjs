/**
 * JSON / JSONL 解析器（零依赖）。
 *
 * 关键取舍：JSON 里最有检索价值的不是缩进后的括号，而是**「路径 = 值」**。
 * 因此每个叶子节点输出一行 `a.b[0].c = 值`（同时保留键名与值），
 * 这样检索「负责人 张三」能命中，而不是命中一堆 `{` 和 `}`。
 *
 * 支持：
 *   · 标准 JSON（对象/数组/标量）
 *   · JSON Lines（每行一个 JSON，常见于日志/导出）—— 整体解析失败时自动尝试
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { stripBom, normSpace } from './util.mjs';

const MAX_LEAVES = 200_000;   // 防病态大文件把 worker 拖死

function walk(value, path, out, depth) {
  if (out.length >= MAX_LEAVES) return;
  if (value === null || typeof value !== 'object') {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    // 短数组中每个元素单独成行；长数组只标注长度（避免几万条把索引撑爆）
    if (value.length > 200) {
      out.push({ path, value: '（数组，共 ' + value.length + ' 项）' });
      const sample = value.slice(0, 50);
      sample.forEach((v, i) => walk(v, path + '[' + i + ']', out, depth + 1));
      return;
    }
    value.forEach((v, i) => walk(v, path + '[' + i + ']', out, depth + 1));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    walk(v, path ? path + '.' + k : k, out, depth + 1);
  }
}

function renderLeaf(path, value) {
  if (value === null) return path + ' = null';
  if (typeof value === 'string') return path + ' = ' + normSpace(value);
  return path + ' = ' + String(value);
}

function fromLeaves(leaves, locKey) {
  const blocks = leaves.map((l, i) => ({
    text: renderLeaf(l.path, l.value),
    kind: 'field',
    loc: locKey ? { [locKey]: i + 1 } : {},
    jsonPath: l.path,
  }));
  return blocks;
}

/**
 * @param {Buffer|string} input
 * @param {{filename?:string}} opts
 */
export function parseJson(input, opts = {}) {
  const raw = Buffer.isBuffer(input) ? input.toString('utf8') : String(input == null ? '' : input);
  const src = stripBom(raw).trim();
  const warnings = [];

  if (!src) {
    return { text: '', blocks: [], meta: { format: 'json' }, parser: 'json', warnings: ['文件为空'] };
  }

  let data = null;
  let mode = 'json';
  try {
    data = JSON.parse(src);
  } catch (e) {
    // 退一步：JSONL
    const lines = src.split(/\r?\n/).filter((l) => l.trim());
    const parsed = [];
    let bad = 0;
    for (const l of lines) {
      try { parsed.push(JSON.parse(l)); } catch { bad++; }
    }
    if (parsed.length && bad === 0) {
      mode = 'jsonl';
      data = parsed;
      warnings.push('整体不是合法 JSON，但每一行都是（按 JSON Lines 解析）');
    } else {
      // 如实失败：带上原始错误信息，不返回空内容假装成功
      const err = new Error('JSON 解析失败：' + e.message);
      err.code = 'parse_failed';
      err.raw = e.message;
      throw err;
    }
  }

  const leaves = [];
  walk(data, '', leaves, 0);
  if (leaves.length >= MAX_LEAVES) warnings.push('叶子节点超过 ' + MAX_LEAVES + ' 条，已截断（避免拖死进程）');

  const blocks = fromLeaves(leaves, mode === 'jsonl' ? 'row' : null);
  const text = blocks.map((b) => b.text).join('\n');
  return {
    text,
    blocks,
    meta: { format: mode, leaves: leaves.length, topLevelKeys: (data && typeof data === 'object' && !Array.isArray(data)) ? Object.keys(data).slice(0, 50) : [] },
    parser: mode,
    warnings,
  };
}
