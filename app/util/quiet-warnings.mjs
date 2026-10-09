/**
 * 收敛 `node:sqlite` 的 ExperimentalWarning。
 *
 * 机制（已实测）：Node 的默认警告打印由一个内部 `warning` 监听器完成；
 * `removeAllListeners('warning')` 后再挂上自己的监听器即可接管输出。
 *
 * ⚠️ **本模块必须在使用方文件里第一个 import**：ESM 按 import 声明顺序求值，
 * 只要它排在 `data/db.mjs` 之前，警告就会在 node:sqlite 被加载之前被接管。
 * 若排在其后，警告已经打印过了，接管无效。
 *
 * 同时保留对**其他**警告的透传 —— 只收敛 SQLite 这一条，不影响别的诊断信息。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
const prior = process.listeners('warning');
process.removeAllListeners('warning');

process.on('warning', (w) => {
  const name = (w && w.name) || '';
  const msg = String((w && w.message) || '');
  if (name === 'ExperimentalWarning' && /SQLite/i.test(msg)) return;
  if (prior.length) {
    for (const l of prior) { try { l.call(process, w); } catch { /* 单个监听器异常不影响其他 */ } }
    return;
  }
  // 没有既有监听器时，用 Node 相近的格式补一条，避免把有用信息吞掉
  console.error('(node) ' + name + (msg ? ': ' + msg : ''));
});
