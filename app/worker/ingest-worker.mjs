/**
 * 摄取 worker 线程入口。
 *
 * 协议（主线程 ↔ 本 worker）：
 *   收：{ id:number, job:object }
 *   发：{ id, ok:true, result } | { id, ok:false, error:{message,code} }
 *
 * 为什么把解析放在 worker 里：`pdftotext` / `libreoffice` 是**同步阻塞**调用，
 * LibreOffice 首次启动动辄几秒。放主线程 = 整个服务的接口在这几秒内全卡住。
 * 放进 worker 后，阻塞只发生在这一个线程上，事件循环照常服务其它请求。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import '../util/quiet-warnings.mjs';
import { parentPort } from 'node:worker_threads';
import { runIngestJob } from '../platform/knowledge/ingest-job.mjs';

if (!parentPort) {
  // 被当普通脚本跑了 —— 明确报错，而不是静默什么也不做
  throw new Error('ingest-worker.mjs 只能作为 worker_threads 线程启动');
}

parentPort.on('message', async (msg) => {
  const id = msg && msg.id;
  try {
    const result = await runIngestJob(msg.job || {});
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        message: e && e.message ? e.message : String(e),
        code: (e && e.code) || 'ingest_failed',
        detail: (e && e.detail) || undefined,
      },
    });
  }
});

// 让主线程知道这个 worker 已就绪（避免第一条任务落在还没加载完模块的线程上）
parentPort.postMessage({ ready: true });
