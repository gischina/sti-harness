/**
 * worker_threads 池。
 *
 * 设计要点（每条都对应一个踩过的坑）：
 *  1. **懒创建**：第一次真正摄取时才起线程。否则 `node app/main.mjs --check`
 *     会因为线程池活着而**不退出**（自检脚本挂住是最烦人的故障之一）。
 *  2. **闲时 unref / 忙时 ref**：worker 默认让进程保持存活；空闲时 unref 才能
 *     不阻塞退出，有任务时 ref 才不会让任务在进程退出时被半路掐掉。
 *  3. **就绪信号**：模块加载是异步的，任务必须等 worker 报 ready 再派发，
 *     否则第一条消息可能落在还没挂上监听器的线程上（消息丢失 → Promise 永不 resolve）。
 *  4. **主动替换 ≠ 崩溃**：`respawn` 里 terminate 旧线程会让它以非 0 退出，
 *     若不标记就会触发**级联重建**（无限循环）。用 `slot.dead` 显式区分。
 *  5. **拿不到线程就诚实降级**：内联执行同一份 `runIngestJob`，并在状态里
 *     标注 `mode:'inline'` 与原因 —— 而不是假装线程在工作。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { Worker } from 'node:worker_threads';
import { runIngestJob } from '../platform/knowledge/ingest-job.mjs';

const WORKER_URL = new URL('./ingest-worker.mjs', import.meta.url);

export function createWorkerPool(opts = {}) {
  const name = opts.name || 'ingest';
  const requested = opts.size === undefined || opts.size === null
    ? Number(process.env.STI_WORKERS === undefined ? 2 : process.env.STI_WORKERS)
    : Number(opts.size);
  const size = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 16) : 0;

  let mode = size > 0 ? 'worker' : 'inline';
  let fallbackReason = size > 0 ? null : '线程池大小配置为 0（STI_WORKERS=0），按内联方式执行';
  const slots = [];
  const queue = [];
  let nextId = 0;
  let started = false;
  let closed = false;

  const stats = { completed: 0, failed: 0, restarts: 0, lastError: null, startedAt: null };

  function spawn() {
    let w;
    try {
      w = new Worker(WORKER_URL, { name: name + '-' + (slots.length + 1) });
    } catch {
      return null;
    }
    const slot = { worker: w, id: null, resolve: null, reject: null, ready: false, dead: false };
    w.on('message', (msg) => {
      if (!msg) return;
      if (msg.ready) { slot.ready = true; dispatch(); return; }
      if (msg.id == null) return;
      const ok = msg.ok;
      const payload = ok ? msg.result : msg.error;
      const done = slot.resolve;
      const fail = slot.reject;
      slot.id = null; slot.resolve = null; slot.reject = null;
      if (ok) { stats.completed++; if (done) done(payload); }
      else { stats.failed++; if (fail) fail(materializeError(payload)); }
      release(slot);
    });
    w.on('error', (e) => {
      stats.lastError = { message: e && e.message ? e.message : String(e), at: new Date().toISOString() };
      const fail = slot.reject;
      slot.id = null; slot.resolve = null; slot.reject = null;
      if (fail) { stats.failed++; fail(materializeError({ message: '摄取线程异常：' + (e && e.message ? e.message : String(e)), code: 'worker_error' })); }
      if (!closed && !slot.dead) replace(slot, { message: '线程异常退出后已重建（code=error）' });
    });
    w.on('exit', (code) => {
      slot.ready = false;
      if (slot.dead || closed) return;                  // 主动替换/关闭：不视为崩溃
      const fail = slot.reject;
      slot.id = null; slot.resolve = null; slot.reject = null;
      if (fail) { stats.failed++; fail(materializeError({ message: '摄取线程意外退出（code=' + code + '）', code: 'worker_exit' })); }
      replace(slot, { message: '线程意外退出后已重建（code=' + code + '）' });
    });
    w.unref();
    return slot;
  }

  /** 用新线程顶替旧的（旧线程标记 dead，避免它的 exit 再触发一次替换） */
  function replace(slot, note) {
    if (closed) return;
    slot.dead = true;
    stats.restarts++;
    stats.lastError = { message: note.message, at: new Date().toISOString() };
    try { slot.worker.terminate(); } catch { /* 已经死了 */ }
    const idx = slots.indexOf(slot);
    const fresh = spawn();
    if (!fresh) {
      mode = 'inline';
      fallbackReason = '工作线程无法重建，已降级为内联执行（功能可用，但解析期间会占用主线程）';
      if (idx >= 0) slots.splice(idx, 1);
      drainInline();
      return;
    }
    if (idx >= 0) slots[idx] = fresh; else slots.push(fresh);
    dispatch();
  }

  function release(slot) {
    slot.worker.unref();
    dispatch();
    // 全部空闲且队列为空 → 整体 unref，避免进程被空转的线程池拖住（--check 挂住的典型原因）
    if (!queue.length && !slots.some((s) => s.id != null)) setRef(false);
  }

  /**
   * 只要有**排队或执行中**的任务，就 ref 所有线程让事件循环保持活跃。
   * 否则：worker 被 unref 后没有任何 ref'd 句柄，Node 会直接退出，
   * 于是 `await pool.run(...)` 永远等不到结果（表现为 "unsettled top-level await"）。
   */
  function setRef(flag) {
    for (const s of slots) {
      if (s.dead) continue;
      try { if (flag) s.worker.ref(); else s.worker.unref(); } catch { /* 线程已退出 */ }
    }
  }

  function ensureStarted() {
    if (started) return;
    started = true;
    stats.startedAt = new Date().toISOString();
    for (let i = 0; i < size; i++) {
      const s = spawn();
      if (!s) {
        mode = 'inline';
        fallbackReason = '当前运行时无法创建 worker 线程，已降级为内联执行';
        break;
      }
      slots.push(s);
    }
    if (mode === 'worker' && !slots.length) { mode = 'inline'; fallbackReason = '未能创建任何工作线程'; }
  }

  function dispatch() {
    if (mode !== 'worker') return;
    while (queue.length) {
      const free = slots.find((s) => s.ready && s.id == null && !s.dead);
      if (!free) break;
      const task = queue.shift();
      free.id = task.id;
      free.resolve = task.resolve;
      free.reject = task.reject;
      free.worker.ref();
      free.worker.postMessage({ id: task.id, job: task.job });    }
  }

  function drainInline() {
    while (queue.length) {
      const task = queue.shift();
      runIngestJob(task.job).then(task.resolve, task.reject);
    }
  }

  /** 执行一个摄取任务（job 见 ingest-job.mjs） */
  function run(job) {
    if (closed) return Promise.reject(materializeError({ message: '线程池已关闭', code: 'pool_closed' }));
    ensureStarted();
    if (mode === 'inline') return runIngestJob(job);
    return new Promise((resolve, reject) => {
      queue.push({ id: ++nextId, job, resolve, reject });
      setRef(true);              // 先 ref，再派发：中间不能有"没有 ref'd 句柄"的窗口
      dispatch();
    });
  }

  function describe() {
    return {
      name,
      mode,
      declaredSize: size,
      started,
      workers: slots.length,
      busy: slots.filter((s) => s.id != null).length,
      queued: queue.length,
      fallbackReason,
      completed: stats.completed,
      failed: stats.failed,
      restarts: stats.restarts,
      lastError: stats.lastError,
      note: mode === 'inline'
        ? '解析/分块在主线程执行：功能完整，但解析大文件（尤其 Office 文档）期间接口会变慢。'
        : '解析/分块/向量化在 worker_threads 中执行，主线程事件循环不受阻塞。',
    };
  }

  async function close() {
    closed = true;
    const err = materializeError({ message: '线程池已关闭，任务被取消', code: 'pool_closed' });
    while (queue.length) queue.shift().reject(err);
    await Promise.all(slots.map((s) => {
      s.dead = true;
      try { return s.worker.terminate(); } catch { return Promise.resolve(); }
    }));
    slots.length = 0;
  }

  return { run, describe, close, get mode() { return mode; }, get size() { return size; } };
}

function materializeError(e) {
  const err = new Error((e && e.message) || '摄取失败');
  err.code = (e && e.code) || 'ingest_failed';
  if (e && e.detail) err.detail = e.detail;
  return err;
}
