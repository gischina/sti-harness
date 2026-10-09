/**
 * Agent 内核契约 —— **产品层唯一能看到的内核接口**。
 *
 * 架构纪律（本项目从业界 Agent 平台的开源实践中学到的最重要一条）：
 *   · 任何 DSH 专有的字段、错误码、事件形态，都必须在 `dsh-provider/` 内
 *     被翻译成本契约的形状；产品层与前端**不认识 DSH**。
 *   · 落库 schema 用**自己的语义字段名**（input_tokens 等），
 *     上游字段名**只允许出现在 dsh-provider/events.mjs 内**。
 *     否则上游改名会让字段静默变空而不报错（feasibility §6.3）。
 *
 * 本文件不 import 任何 provider —— 它是纯定义 + 归一化工具，可被任意 provider 复用。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */

/** 契约版本。KernelEvent 形状变更必须同时改这里。 */
export const CONTRACT_VERSION = '1.1.0';

/**
 * 已知事件类型（这是**已验证**的集合；不在其中的事件会被标记 known:false 而不是丢弃）。
 *
 * `lifecycle` = 上游日志的**骨架/生命周期标记**（step、request、seed 边界等）。
 * 它们对模型可见轨迹没有贡献，但**必须被显式识别**——否则轨迹页会把它们一股脑
 * 显示成"未知事件"，真有未知变更时反而看不出来。骨架事件用 `kind` 区分具体是哪种。
 */
export const EVENT_TYPES = [
  'turn-start',
  'reasoning',
  'message',
  'tool-call',
  'tool-result',
  'approval',
  'usage',
  'error',
  'turn-end',
  'lifecycle',
];

export const ROLES = ['user', 'assistant', 'system', 'tool'];

/**
 * usage 的语义字段（与上游命名解耦）。
 *
 * ⚠️ **`input` 的语义是「未缓存输入」，不是「总输入」**——这与上游一致。
 * 上游 `TokenUsage` 的注释原文：
 *   "Counts are DISJOINT: `inputTokens` is uncached input only; cached input is reported
 *    separately as `cacheReadTokens`/`cacheWriteTokens` (billed input = sum of the three)."
 * 因此**计费输入 = input + cacheRead + cacheWrite**；reasoning 是 output 的子集，不另计。
 * 搞错这一条会让用量统计出现系统性偏差却不报错，所以在此显式写明。
 */
export const USAGE_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pickUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const u = {};
  let any = false;
  for (const f of USAGE_FIELDS) {
    if (raw[f] != null) { u[f] = num(raw[f]); any = true; }
  }
  if (!any) return null;
  for (const f of USAGE_FIELDS) if (u[f] == null) u[f] = 0;
  return u;
}

/**
 * 把 provider 归一化后的事件做**最终校验与补全**。
 * 约定：provider 负责把上游翻译成接近本形状；本函数负责补齐字段、标记未知类型，
 * **绝不猜测**缺失的语义信息（缺就是缺，标 known:false / usage:null）。
 *
 * @param {object} ev  provider 产出的事件（已用语义字段名）
 * @param {{seq?:number, turnId?:string}} ctx
 * @returns {object} 规范化的 KernelEvent
 */
export function normalizeEvent(ev, ctx = {}) {
  const src = ev && typeof ev === 'object' ? ev : {};
  const type = String(src.type || 'unknown');
  const known = EVENT_TYPES.includes(type);
  const role = ROLES.includes(src.role) ? src.role : (src.role ? String(src.role) : null);

  /** 归一化可疑点（如"用量分项与上游 total 对不上"）。这是**如实上报**的通道，不是错误。 */
  const warnings = Array.isArray(src.warnings)
    ? src.warnings.map(String).filter(Boolean)
    : [];
  if (!known && !warnings.includes('unknown_event_type')) warnings.push('unknown_event_type');

  const out = {
    seq: src.seq != null ? Number(src.seq) : (ctx.seq != null ? Number(ctx.seq) : 0),
    turnId: src.turnId != null ? String(src.turnId) : (ctx.turnId != null ? String(ctx.turnId) : null),
    type,
    known,
    /** 骨架事件的具体种类（如 step-start / request-header / session-end-seed）；非骨架为 null */
    kind: src.kind != null ? String(src.kind) : null,
    role,
    text: src.text != null ? String(src.text) : null,
    delta: src.delta != null ? String(src.delta) : null,
    tool: src.tool && typeof src.tool === 'object'
      ? {
        name: String(src.tool.name || ''),
        args: src.tool.args ?? null,
        result: src.tool.result ?? null,
        status: src.tool.status ? String(src.tool.status) : null,
        // 配对 id（0.21.10）：`tool/call` 给 `callId`、`tool/result` 给
        // `message.toolCallId`，同一个值。它是**唯一**能把结果并回正确那张卡的凭据 ——
        // 名字做不到（同一轮调同名工具两次会错配），而且 `tool/result` 里
        // **压根没有名字**，靠名字配对会凭空多出一张空名卡。
        // 取不到时是 `null`（"上游没给"），**不是** `''`（"给了个空 id"）：前端据此
        // 决定"退回按名字配对"而不是"按空串去配对一堆匿名卡"。
        callId: src.tool.callId != null ? String(src.tool.callId) : null,
      }
      : null,
    usage: pickUsage(src.usage),
    warnings,
    at: src.at ? String(src.at) : new Date().toISOString(),
  };
  return out;
}

/** 契约之外的**允许扩展**方法名（provider 可选的平台级能力，不算架构违规） */
export const PROVIDER_EXTENSIONS = [
  'status', 'probe', 'createUpgradeHandler', 'forwardRequest',
  'dumpPlugins', 'skillsRoots', 'mappingReport', 'compatReport',
];

/**
 * 契约自检：一个 provider 是否实现了必需方法。
 * 返回 { ok, missing[], extra[] } —— 用于 `--check` 与回归，**不做拦截**，
 * 由调用方决定是降级还是报错。
 */
export function inspectProvider(provider) {
  const required = [
    'describe',
    'createSession', 'listSessions', 'renameSession', 'forkSession', 'cancelSession', 'disposeSession',
    'submitTurn', 'cancelTurn', 'streamTurns',
    'subscribe', 'snapshot',
    'modelCatalog', 'selectModel',
    'listSkills', 'listMcpServers',
    // ⚠️ 0.21.10：`listTools` 删除、`listPlugins` 补上 —— 它们是**同一次改名**的
    //    两半，少改一处契约就会自相矛盾。
    //    从前这个方法叫 `listTools`，但它从来只返回插件（上游没有"工具清单" RPC，
    //    有 RPC 的是 `pluginInventory/list`）。工具那套概念删掉后，方法正名为它实际
    //    在做的事。**契约漏改名**的后果是 `inspectProvider` 把真实 provider 的
    //    `listPlugins` 报成 extra —— 契约说"没这个方法"、provider 却实现了，
    //    两边对不上，而这条路只有 `--check` 里的契约自检才会走到。
    'listPlugins',
    'listAgentPresets',
    'listPendingApprovals', 'respondApproval',
    'listArtifacts', 'readAttachment',
  ];
  const optional = ['reset', 'close', 'client', ...PROVIDER_EXTENSIONS];
  const missing = [];
  const extra = [];
  if (!provider || typeof provider !== 'object') {
    return { ok: false, missing: required, extra: [], name: '(none)' };
  }
  for (const m of required) if (typeof provider[m] !== 'function') missing.push(m);
  for (const k of Object.keys(provider)) {
    if (k.startsWith('_')) continue;
    if (!required.includes(k) && !optional.includes(k) && typeof provider[k] === 'function') extra.push(k);
  }
  return { ok: missing.length === 0, missing, extra, name: provider.name || '(unnamed)' };
}

/** 契约的机器可读描述（给状态页与文档用，避免文档与代码漂移） */
export function describeContract() {
  return {
    version: CONTRACT_VERSION,
    eventTypes: EVENT_TYPES.slice(),
    roles: ROLES.slice(),
    usageFields: USAGE_FIELDS.slice(),
    methods: [
      'describe', 'createSession', 'listSessions', 'renameSession', 'forkSession',
      'cancelSession', 'disposeSession', 'submitTurn', 'cancelTurn', 'streamTurns',
      'subscribe', 'snapshot', 'modelCatalog', 'selectModel', 'listSkills',
      'listMcpServers', 'listPlugins', 'listAgentPresets', 'listPendingApprovals', 'respondApproval', 'listArtifacts', 'readAttachment',
    ],
    // provider **可选**实现的平台级扩展（不计入 required，inspectProvider 也不算 extra）
    optionalMethods: PROVIDER_EXTENSIONS.slice(),
  };
}
