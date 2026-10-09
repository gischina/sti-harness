/**
 * 摄取任务（parse → chunk → bigram → 向量化）的**唯一实现**。
 *
 * 为什么单独成文件：这段代码既要在 worker 线程里跑，也要能在
 * 「拿不到 worker（线程不可用 / 池大小配成 0）」时**在主线程内联执行**。
 * 若为了内联再写一份，就会出现两份逻辑 —— 而本项目已经吃过这个亏
 * （同一段判断写两遍，其中一份是错的）。所以：**一份实现，两种调用方式**。
 *
 * 向量化失败**不会让整篇文档失败**：会把 warning 带上、退回纯文本索引。
 * 理由是「向量服务临时不可用」不该导致资料进不了库（那样更糟）。
 * 但失败原因会如实记在文档告警与知识库状态里，不静默吞掉。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import { parseDocument } from './parsers/index.mjs';
import { chunkBlocks, DEFAULT_OPTIONS } from './chunker.mjs';
import { toIndexText } from '../../util/bigram.mjs';
import { createEmbeddingProvider } from './embedding.mjs';

/**
 * @param {{filename?:string, mime?:string,
 *          source:{kind:'buffer', bytes:Uint8Array|Buffer}|{kind:'text', text:string},
 *          options?:object,
 *          embed?:null|{provider:string, baseUrl:string, model:string, dim?:number, apiKey?:string, timeoutMs?:number}}} job
 */
export async function runIngestJob(job) {
  const filename = String(job.filename || '');
  const mime = String(job.mime || '');
  const opts = { ...DEFAULT_OPTIONS, ...(job.options || {}) };

  // ── 1) 解析 ────────────────────────────────────────────────────
  const src = job.source || {};
  const parsed = src.kind === 'text'
    ? parseDocument({ text: String(src.text == null ? '' : src.text), filename: filename || 'pasted.txt', mime })
    : parseDocument({ buffer: Buffer.from(src.bytes || []), filename, mime });

  const warnings = (parsed.warnings || []).slice();

  // ── 2) 分块 ────────────────────────────────────────────────────
  const chunks = chunkBlocks(parsed.blocks || [], opts);
  if (!chunks.length) {
    warnings.push('解析成功但没有产出任何分块（文档可能是空的，或内容全部被识别为空白）');
  }

  // ── 3) bigram 索引串（中文检索的唯一可行路径）────────────────────
  for (const c of chunks) c.bigrams = toIndexText(c.body);

  // ── 4) 向量化（可选；失败不致命）───────────────────────────────
  let vectors = null;
  let dim = 0;
  let embedding = null;
  if (job.embed && chunks.length) {
    const provider = createEmbeddingProvider(job.embed);
    try {
      const r = await provider.embed(chunks.map((c) => c.body));
      if (r) {
        vectors = r.vectors;
        dim = r.dim;
        embedding = { mode: provider.mode, model: provider.model, dim, count: vectors.length };
      } else {
        embedding = { mode: 'none', model: null, dim: 0, count: 0 };
      }
    } catch (e) {
      // 如实记录，但不让文档失败
      warnings.push('向量化失败（已退回纯文本检索）：' + (e && e.message ? e.message : String(e)));
      embedding = { mode: 'failed', model: provider.model, dim: 0, count: 0, error: { code: e.code, message: e.message } };
    }
  }

  return {
    parser: parsed.parser,
    meta: parsed.meta || {},
    degraded: !!parsed.degraded,
    warnings,
    chunkCount: chunks.length,
    dim,
    embedding,
    chunks: chunks.map((c) => ({
      ord: c.ord, body: c.body, bigrams: c.bigrams, meta: c.meta, tokenCount: c.tokenCount,
    })),
    // Float32Array 在 worker 之间可被结构化克隆；这里保留类型，避免转成普通数组带来的膨胀
    vectors: vectors ? vectors.map((v) => ({ dim: v.length, data: v })) : null,
  };
}
