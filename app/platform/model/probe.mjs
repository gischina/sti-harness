/**
 * 模型连通性探活（P1-1）。
 *
 * 为什么值得单独一个文件（而不是塞进 service.mjs）：
 *   · 探活是**唯一会向外发网络请求**的地方，把它隔离出来，读代码的人一眼能看到
 *     "平台在哪里主动出网"；
 *   · 它是纯的（输入配置 → 输出结论），不碰数据库，因此可以单独被回归穷举。
 *
 * 三条纪律（与全项目一致）：
 *  1. **真探，不猜**。`ok:false` 一定对应一次真实的失败，并把失败原因分门别类
 *     （不可达 / 超时 / 鉴权 / 协议不符），而不是笼统回一个"失败"。
 *  2. **探活与真实调用共用同一实现**（向量走 `createEmbeddingProvider`）。
 *     否则会出现最让人恼火的状态：**探活通过、导入失败** —— 因为两段代码
 *     对 URL 拼接或响应结构的理解不一样。共用一份实现，这种分歧在结构上不可能。
 *  3. **不泄漏密钥**。返回的结论里只出现"配没配密钥"，永不出现它的值。
 *
 * ⚠️ 诚实提醒：对话探活会**真的发一次最小请求**（`max_tokens: 1`）。
 * 这会产生极少量用量。之所以不做"只探测端口通不通"，是因为"端口通"不能说明
 * 密钥有效、模型名存在、协议对得上 —— 那种探活给的是**虚假的安心**。
 * 结论里会带上 `billedRequest: true` 让运维知道这一点。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { createEmbeddingProvider } from '../knowledge/embedding.mjs';

/** kind → 该 kind 允许的协议。不在这张表里的组合一律拒绝（宁可拒绝也不猜）。 */
export const PROTOCOLS_BY_KIND = {
  chat: ['anthropic-messages', 'openai-compat'],
  embedding: ['openai-compat', 'ollama', 'none'],
};

export const KINDS = Object.keys(PROTOCOLS_BY_KIND);

/** 拼接 base 与后缀；`/v1` 已存在就不重复加（避免 `/v1/v1/`）。 */
function joinV1(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  if (!b) return null;
  if (/\/v\d+$/.test(b)) return b + suffix;
  return b + '/v1' + suffix;
}

/** 把"端点"算出来（也用于在界面上显示"到底打了哪个地址"，便于运维自查） */
export function endpointFor(kind, protocol, baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (!b) return null;
  if (kind === 'chat' && protocol === 'anthropic-messages') return joinV1(b, '/messages');
  if (kind === 'chat' && protocol === 'openai-compat') return joinV1(b, '/chat/completions');
  if (kind === 'embedding' && protocol === 'openai-compat') return joinV1(b, '/embeddings');
  if (kind === 'embedding' && protocol === 'ollama') return b + '/api/embed';
  return null;
}

/**
 * 分类一次失败，产出人能够据以动手的 code。
 * 分类本身就是"诚实数据源"的一部分：笼统的 "探活失败" 让运维无从下手。
 */
function classifyError(e, timeoutMs, url) {
  if (e && e.name === 'AbortError') {
    return { code: 'timeout', message: '调用超时（' + timeoutMs + 'ms）：' + url };
  }
  const msg = e && e.message ? String(e.message) : String(e);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg)) {
    return { code: 'unreachable', message: '服务不可达：' + msg, detail: { url } };
  }
  return { code: 'probe_failed', message: msg, detail: { url } };
}

/**
 * 对话模型探活：发一次最小请求，按真实 HTTP 结果给结论。
 * @returns {Promise<object>} 统一的结论形状（见文件末注释）
 */
async function probeChat({ protocol, baseUrl, model, apiKey, timeoutMs }) {
  const url = endpointFor('chat', protocol, baseUrl);
  if (!baseUrl) return fail('not_configured', '缺少 baseUrl（模型服务的根地址）');
  if (!model) return fail('not_configured', '缺少模型名');
  if (!url) return fail('bad_protocol', '对话不支持该协议：' + protocol);

  const headers = { 'content-type': 'application/json' };
  let body;
  if (protocol === 'anthropic-messages') {
    // 该协议的鉴权头与版本头是它自身的规格，不是"上游产品的名词"
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
  } else {
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;
    body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    const latencyMs = Date.now() - started;
    const text = (await res.text()).slice(0, 400);
    if (res.ok) {
      return {
        ok: true, level: 'ok', code: 'ok',
        message: '连通正常（HTTP ' + res.status + '）',
        latencyMs, endpoint: url, billedRequest: true,
        detail: { status: res.status, hasCredential: !!apiKey },
      };
    }
    // 4xx/5xx：带着状态码与响应片段回报 —— 运维据此区分"密钥错"与"模型名错"
    const code = res.status === 401 || res.status === 403 ? 'auth_rejected'
      : res.status === 404 ? 'not_found'
        : res.status === 429 ? 'rate_limited' : 'http_error';
    return {
      ok: false, level: 'fail', code,
      message: '服务返回 HTTP ' + res.status + '：' + text,
      latencyMs, endpoint: url, billedRequest: false,
      detail: { status: res.status, hasCredential: !!apiKey, body: text },
    };
  } catch (e) {
    const c = classifyError(e, timeoutMs, url);
    return { ok: false, level: 'fail', code: c.code, message: c.message, latencyMs: Date.now() - started, endpoint: url, billedRequest: false, detail: c.detail || {} };
  } finally {
    clearTimeout(timer);
  }
}

/** 向量模型探活：直接复用知识层那份实现（见文件头纪律 2） */
async function probeEmbedding({ protocol, baseUrl, model, apiKey, timeoutMs, dim }) {
  if (protocol === 'none') {
    // 「显式不配向量」是**预期状态**，不是故障：检索退化为纯文本，这是设计好的降级。
    return {
      ok: true, level: 'skipped', code: 'not_configured',
      message: '未配置向量模型：检索为纯文本（bigram + FTS5 bm25）。这是预期状态，不是故障。',
      latencyMs: 0, endpoint: null, billedRequest: false, detail: { mode: 'none' },
    };
  }
  if (!baseUrl) return fail('not_configured', '缺少 baseUrl（模型服务的根地址）');
  if (!model) return fail('not_configured', '缺少模型名');

  const provider = createEmbeddingProvider({ provider: protocol, baseUrl, model, apiKey, dim, timeoutMs });
  const started = Date.now();
  const h = await provider.health();          // 内部已把失败原因分类（http/timeout/unreachable/dim）
  const latencyMs = Date.now() - started;
  if (h && h.ok) {
    return {
      ok: true, level: 'ok', code: 'ok',
      message: '连通正常，返回 ' + (h.dim || 0) + ' 维向量',
      latencyMs, endpoint: provider.endpoint || endpointFor('embedding', protocol, baseUrl),
      billedRequest: true, detail: { dim: h.dim || 0, mode: h.mode },
    };
  }
  const err = (h && h.error) || {};
  return {
    ok: false, level: 'fail', code: err.code || 'probe_failed',
    message: err.message || '向量服务探活失败',
    latencyMs, endpoint: provider.endpoint || endpointFor('embedding', protocol, baseUrl),
    billedRequest: false, detail: { mode: h && h.mode },
  };
}

function fail(code, message) {
  return { ok: false, level: 'fail', code, message, latencyMs: 0, endpoint: null, billedRequest: false, detail: {} };
}

/**
 * 统一探活入口。
 *
 * 结论形状（固定五段，调用方与前端都按它渲染）：
 *   { ok, level:'ok'|'fail'|'skipped', code, message, latencyMs, endpoint, billedRequest, detail }
 *
 * `level:'skipped'` 与 `ok:true` 同时出现，表示"这条没配，是预期状态"——
 * 与"配了但连不上"（`level:'fail'`）严格区分。**把两者混为一谈会误导运维。**
 *
 * @param {{kind:string, protocol:string, baseUrl:string, model:string,
 *          apiKey?:string, timeoutMs?:number, dim?:number}} cfg
 */
export async function probeModel(cfg = {}) {
  const kind = String(cfg.kind || '');
  const protocol = String(cfg.protocol || '');
  const allowed = PROTOCOLS_BY_KIND[kind];
  if (!allowed) return fail('bad_kind', '未知的模型用途：' + kind + '（只允许 ' + KINDS.join(' / ') + '）');
  if (!allowed.includes(protocol)) {
    return fail('bad_protocol', kind + ' 不支持协议 ' + protocol + '（允许：' + allowed.join(' / ') + '）');
  }
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 15000;
  return kind === 'chat'
    ? probeChat({ protocol, baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, timeoutMs })
    : probeEmbedding({ protocol, baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, timeoutMs, dim: cfg.dim });
}
