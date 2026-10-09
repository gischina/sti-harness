/**
 * Embedding provider 抽象 —— 三种模式 + **关键词降级**。
 *
 * | 模式            | 说明                                              |
 * |-----------------|---------------------------------------------------|
 * | `openai-compat` | 任何 OpenAI 兼容的 `/embeddings` 接口（含本地 vLLM、LM Studio、DashScope 兼容层） |
 * | `ollama`        | 本地 Ollama（`/api/embed`，兼容旧版 `/api/embeddings`） |
 * | `none`          | **不配向量**：检索退化为纯 FTS5（bigram）。这是默认值，也是唯一零依赖的可用形态。 |
 *
 * 三条纪律：
 *  1. **不假装有向量**。`none` 模式下 `embed()` 返回 `null`，调用方据此走纯文本检索；
 *     绝不返回一批零向量 —— 那会让「向量路径」看起来在工作，实际全是噪声。
 *  2. **不泄漏密钥**。`describe()` 只报「有没有配密钥」，任何日志与响应里都不出现它的值。
 *  3. **向量在出口处 L2 归一化**。这样余弦相似度就等于点积，检索循环里少一次开方，
 *     也避免不同 provider 的向量尺度差异影响 RRF 融合。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
export const EMBED_MODES = ['openai-compat', 'ollama', 'none'];

export class EmbeddingError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'EmbeddingError';
    this.code = detail.code || 'embedding_failed';
    this.detail = detail;
  }
}

/** 归一化 provider 名；空值/未知值一律落到 'none'（宁可退化为纯文本，也不猜） */
export function normalizeMode(provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (!p) return 'none';
  if (p === 'none' || p === 'off' || p === 'keyword' || p === 'disabled') return 'none';
  if (p === 'ollama') return 'ollama';
  if (p === 'openai' || p === 'openai-compat' || p === 'openai-compatible' || p === 'compatible' || p === 'vllm') return 'openai-compat';
  return 'none';
}

function joinUrl(base, suffix, { ensureV1 = false } = {}) {
  const b = String(base || '').replace(/\/+$/, '');
  if (!b) return null;
  if (!ensureV1) return b + suffix;
  if (/\/v\d+$/.test(b)) return b + suffix;
  return b + '/v1' + suffix;
}

function l2(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (!n) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * @param {{provider?:string, baseUrl?:string, model?:string, dim?:number, apiKey?:string, timeoutMs?:number, keepAliveMs?:number}} opts
 */
export function createEmbeddingProvider(opts = {}) {
  const mode = normalizeMode(opts.provider);
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  const model = String(opts.model || '');
  const declaredDim = Number(opts.dim) > 0 ? Number(opts.dim) : 0;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 20_000;
  const hasKey = !!opts.apiKey;
  let observedDim = declaredDim;
  let lastError = null;

  const endpoint = mode === 'openai-compat'
    ? joinUrl(baseUrl, '/embeddings', { ensureV1: true })
    : mode === 'ollama'
      ? joinUrl(baseUrl, '/api/embed')
      : null;

  function describe() {
    return {
      mode,
      model: model || null,
      baseUrl: baseUrl || null,
      endpoint: endpoint || null,
      dim: observedDim || null,
      hasApiKey: hasKey,
      lastError: lastError ? { message: lastError.message, code: lastError.code } : null,
      note: mode === 'none'
        // ⚠️ 这段话会原样显示在页面上（纯文本渲染，没有 markdown）——别写 `**`，
        // 用户会看到字面星号（2026-10-02 真机实测抓到过一轮）。
        ? '未配置向量模型：检索为纯文本（bigram + FTS5 bm25），语义相近但用词不同的内容召不回。'
        : '向量来自外部服务，其可用性由每次调用的真实结果决定（失败会如实上报，不会静默降级为 0 向量）。',
    };
  }

  async function post(url, body, extraHeaders = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...extraHeaders },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      if (!res.ok) {
        throw new EmbeddingError('向量服务返回 HTTP ' + res.status + '：' + String(text).slice(0, 300), {
          code: 'embedding_http_error', status: res.status, url,
        });
      }
      return json;
    } catch (e) {
      if (e instanceof EmbeddingError) throw e;
      if (e && e.name === 'AbortError') {
        throw new EmbeddingError('向量服务调用超时（' + timeoutMs + 'ms）：' + url, { code: 'embedding_timeout', url });
      }
      throw new EmbeddingError('向量服务不可达：' + (e && e.message ? e.message : String(e)), { code: 'embedding_unreachable', url });
    } finally {
      clearTimeout(timer);
    }
  }

  async function callOpenAi(texts) {
    const json = await post(endpoint, { model, input: texts }, hasKey ? { authorization: 'Bearer ' + opts.apiKey } : {});
    const data = json && Array.isArray(json.data) ? json.data : null;
    if (!data || data.length !== texts.length) {
      throw new EmbeddingError('向量服务返回结构不符合 OpenAI 规范（缺 data[] 或条数不匹配）', {
        code: 'embedding_bad_response', got: data ? data.length : null, expected: texts.length,
      });
    }
    return data.map((d) => d && d.embedding);
  }

  async function callOllama(texts) {
    // 新接口
    try {
      const json = await post(joinUrl(baseUrl, '/api/embed'), { model, input: texts });
      if (json && Array.isArray(json.embeddings)) return json.embeddings;
      if (json && Array.isArray(json.embedding)) return [json.embedding];
      throw new EmbeddingError('Ollama 返回结构无法识别（缺 embeddings[]）', { code: 'embedding_bad_response' });
    } catch (e) {
      if (!(e instanceof EmbeddingError) || e.code !== 'embedding_http_error' || e.detail.status !== 404) throw e;
      // 旧接口（单条）
      const out = [];
      for (const t of texts) {
        // eslint-disable-next-line no-await-in-loop
        const json = await post(joinUrl(baseUrl, '/api/embeddings'), { model, prompt: t });
        if (!json || !Array.isArray(json.embedding)) {
          throw new EmbeddingError('Ollama 返回结构无法识别（缺 embedding[]）', { code: 'embedding_bad_response' });
        }
        out.push(json.embedding);
      }
      return out;
    }
  }

  /**
   * 向量化一批文本。
   * @param {string[]} texts
   * @returns {Promise<{vectors:Float32Array[], dim:number}|null>} `null` = 未配置向量（走纯文本检索）
   */
  async function embed(texts) {
    const list = (texts || []).map((t) => String(t == null ? '' : t));
    if (!list.length) return { vectors: [], dim: observedDim || 0 };
    if (mode === 'none') return null;
    if (!baseUrl) {
      throw new EmbeddingError('已配置向量模式 ' + mode + '，但缺少 baseUrl', { code: 'embedding_not_configured' });
    }
    if (!model) {
      throw new EmbeddingError('已配置向量模式 ' + mode + '，但缺少模型名', { code: 'embedding_not_configured' });
    }

    let raw;
    try {
      raw = mode === 'ollama' ? await callOllama(list) : await callOpenAi(list);
    } catch (e) {
      lastError = e;
      throw e;
    }
    lastError = null;

    const vectors = [];
    for (const v of raw) {
      if (!v || !v.length) throw new EmbeddingError('向量服务返回了空向量', { code: 'embedding_bad_response' });
      const arr = v instanceof Float32Array ? v : Float32Array.from(v);
      if (observedDim && arr.length !== observedDim) {
        throw new EmbeddingError(
          '向量维度与知识库不一致：库为 ' + observedDim + ' 维，模型返回 ' + arr.length + ' 维。'
          + '混用不同维度的向量会让相似度完全失效，因此这里直接失败而不是截断/补齐。',
          { code: 'embedding_dim_mismatch', expected: observedDim, got: arr.length }
        );
      }
      observedDim = arr.length;
      vectors.push(l2(arr));
    }
    return { vectors, dim: observedDim };
  }

  /** 真实探活：发一小段文本，看能不能拿到向量。用于状态页与自检（不猜） */
  async function health() {
    if (mode === 'none') return { ok: true, mode, note: '未配置向量模型，检索为纯文本模式（这是预期行为）' };
    try {
      const r = await embed(['连通性检测']);
      return { ok: true, mode, dim: r ? r.dim : 0 };
    } catch (e) {
      return { ok: false, mode, error: { code: e.code, message: e.message } };
    }
  }

  return {
    mode,
    get dim() { return observedDim; },
    model: model || null,
    baseUrl: baseUrl || null,
    endpoint,
    describe,
    embed,
    health,
  };
}
