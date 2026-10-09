/**
 * 兼容垫片解析器 —— 按上游版本挑对应的垫片文件。
 *
 * 为什么需要它：垫片是按上游版本命名的（`0.1.5-rc.2.mjs` / `0.2.0-rc.2.mjs`…），
 * 而"当前是哪个版本"只有运行时才知道。原先 index.mjs 把垫片路径**写死**成一个，
 * 于是上游一升级就会出现"垫片版本 ≠ 实际版本"却毫无提示的情况 —— 这正是本项目
 * 在 docs/history/assessment-0.6.0.md 里定性为 P0 的那个隐患的成因之一。
 *
 * 选取规则（**精确匹配优先，绝不静默回退到不匹配的垫片**）：
 *   1. 精确命中 `compat/<version>.mjs` → 用它，`exact: true`
 *   2. 未命中 → 用**最新的**垫片，但 `exact: false` 且带 `warning`，
 *      由 describe()/自检页如实显示"垫片与上游版本不一致，方法名可能已变"。
 *
 * 这样"上游升级了但没人更新垫片"会**立刻可见**，而不是安静地错下去。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** 把 `0.2.0-rc.2` 拆成可比较的数字段，用于挑"最新" */
function versionKey(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.?(\d+))?/i.exec(String(v || ''));
  if (!m) return [0, 0, 0, 0, 0];
  const pre = m[4] ? m[4].toLowerCase() : 'zzz';   // 正式版排在预发行之后
  const preRank = { alpha: 1, beta: 2, rc: 3 }[pre] ?? (m[4] ? 2 : 4);
  return [Number(m[1]), Number(m[2]), Number(m[3]), preRank, Number(m[5] || 0)];
}

function cmpVersion(a, b) {
  const ka = versionKey(a), kb = versionKey(b);
  for (let i = 0; i < ka.length; i++) { if (ka[i] !== kb[i]) return ka[i] - kb[i]; }
  return 0;
}

/** 本目录下所有垫片文件名（去扩展名） */
export function availableCompatVersions() {
  try {
    return fs.readdirSync(DIR)
      .filter((f) => /^\d+\.\d+\.\d+.*\.mjs$/.test(f) && f !== 'index.mjs')
      .map((f) => f.replace(/\.mjs$/, ''))
      .sort(cmpVersion);
  } catch { return []; }
}

/**
 * 挑垫片。
 * @param {string} upstreamVersion 上游实际版本（探测所得；未知传 ''）
 * @returns {Promise<{mod:object, version:string, exact:boolean, warning:string}>}
 */
export async function pickCompat(upstreamVersion = '') {
  const avail = availableCompatVersions();
  if (!avail.length) {
    throw new Error('compat 目录下没有任何垫片文件 —— 这是打包/部署事故，请检查 app/kernel/dsh-provider/compat/');
  }

  const want = String(upstreamVersion || '').trim();
  if (want && avail.includes(want)) {
    const mod = await import('./' + want + '.mjs');
    return { mod, version: want, exact: true, warning: '' };
  }

  const latest = avail[avail.length - 1];
  const mod = await import('./' + latest + '.mjs');
  return {
    mod, version: latest, exact: false,
    warning: want
      ? `上游版本 ${want} 没有对应垫片，已退回最新垫片 ${latest}。`
        + '方法名与参数形状可能已变，请跑 `node tools/verify-upstream.mjs` 核实后新增垫片。'
      : `未能探测到上游版本，已退回最新垫片 ${latest}。请跑 check 自检确认上游状态。`,
  };
}

export default { pickCompat, availableCompatVersions };
