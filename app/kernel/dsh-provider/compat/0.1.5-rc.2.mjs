/**
 * 兼容垫片：0.1.5-rc.2
 *
 * ⚠️⚠️ **本表的方法名已被实测证伪，留档仅供追溯，不要在新版本上复用。** ⚠️⚠️
 *
 *   2026-10-01 用 `tools/verify-upstream.mjs` 对运行中的 DSH（0.2.0-rc.2）实测：
 *   本表里 9 个方法名**在上游根本不存在** ——
 *     session/submit（实为 session/prompt，且 content 必须是块数组）
 *     session/interrupt / session/dispose / session/history / session/setModel
 *     agents/skills（实为 skills/list）
 *     approval/request、approval/respond（审批走 $events 事件流，非 RPC）
 *     deliverables/presented（这是**事件类型**，不是端点）
 *
 *   根因：本表的 `verified` 标记来自**对源码的静态核查**（见下方 COMPAT_NOTES），
 *   而静态核查分不清"源码里出现过的字符串"与"运行时可调用的端点"。
 *   → 正确做法见 `compat/0.2.0-rc.2.mjs`：verified 必须由**实际调用**产生。
 *
 * 一个上游版本一个文件，**纯函数优先**，便于旧版本用完后直接删。
 * 这里放的只有两类东西：
 *   1. `UPSTREAM_METHODS` —— 契约方法 ↔ 上游 RPC 方法名的映射表；
 *   2. 该版本特有的行为差异修正。
 *
 * ⚠️ 每条映射都带 `verified`：
 *   true  = 在基线实现的既有代码里确认过该方法名确实在用（**注意：这是静态证据，不等于运行时可用**）；
 *   false = **尚未对着运行中的 DSH 核实**（bestGuess）。
 * provider 默认拒绝调用 verified:false 的方法（除非 STI_ALLOW_UNVERIFIED=1），
 * 以免"看着能跑、实际静默错误"。核实办法见文件末尾 note。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
export const COMPAT_VERSION = '0.1.5-rc.2';

/**
 * 本垫片**不声明**支持图片附件 —— 而且这不是"保守"，是**真的不知道**。
 *
 * 早期垫片里 `submitTurn` 曾把 `attachments: i.attachments` 原样透传，
 * 那是对 `session/submit` 参数形状的**猜测**（整份 0.1.5 垫片都是 verified:false
 * 的静态核查结果，没有对运行中的 DSH 动态验证过）。
 *
 * 为什么不能"猜着传"：上游会因参数形状不符**拒绝整个请求**，代价是用户这一轮
 * 提问完全发不出去 —— 比"图没送成"严重得多。而反过来，**假装送了**更糟：
 * 平台层会据此在 content 里写下"已作为图片块提交给模型"，那是假陈述。
 *
 * 所以这里如实填 `false`：平台会把图片归入 `skipped[]` 并说明原因，
 * 而不是在轨迹里留下一句"已提交"。要用图片请运行 0.2.0-rc.2 或更新版本。
 */
export const SUPPORTS_IMAGE_ATTACHMENTS = false;
export const COMPAT_NOTES = [
  '基线来自同权利人早期作品（按 0.1.5-rc.2 开发）与业界 Agent 平台的开源实践（0.1.6-alpha.1 已复核）。',
  '本表的 verified 标记来自对基线实现源码的静态核查，不是对运行中内核的动态验证。',
];

/**
 * 契约方法 → 上游 RPC。
 * `args: (input) => object` 负责把语义参数翻译成上游信封的 args。
 */
export const UPSTREAM_METHODS = {
  createSession: { method: 'session/create', verified: false, args: (i) => ({ cwd: i.cwd, presetId: i.presetId, title: i.title }) },
  listSessions: { method: 'session/list', verified: false, args: (i) => ({ cursor: i.cursor, limit: i.limit }) },
  renameSession: { method: 'session/rename', verified: false, args: (i) => ({ sessionId: i.sessionId, title: i.title }) },
  forkSession: { method: 'session/fork', verified: false, args: (i) => ({ sessionId: i.sessionId, atSeq: i.atSeq }) },
  cancelSession: { method: 'session/cancel', verified: false, args: (i) => ({ sessionId: i.sessionId }) },
  disposeSession: { method: 'session/dispose', verified: false, args: (i) => ({ sessionId: i.sessionId }) },
  // ⚠️ 刻意**不**透传 `attachments`（上一版在这里猜着传了个 `i.attachments`）。
  //    该参数形状从未被核实 —— 本垫片整份都是 verified:false 的静态核查结果，
  //    而"猜错的形状"会让上游拒绝**整个请求**，用户这轮提问就发不出去了。
  //    平台层已经依据 `SUPPORTS_IMAGE_ATTACHMENTS = false` 把图片归入 skipped[]，
  //    所以这里收不到 attachments；万一收到也直接丢掉 —— 宁可少送，不赌形状。
  submitTurn: { method: 'session/submit', verified: false, args: (i) => ({ sessionId: i.sessionId, content: i.content, mode: i.mode }) },
  cancelTurn: { method: 'session/interrupt', verified: false, args: (i) => ({ sessionId: i.sessionId, turnId: i.turnId }) },

  modelCatalog: { method: 'llm/listConfigurableProviders', verified: true, args: () => ({}) },
  selectModel: { method: 'session/setModel', verified: false, args: (i) => ({ sessionId: i.sessionId, provider: i.provider, model: i.model }) },

  listSkills: { method: 'agents/skills', verified: true, args: () => ({}) },
  listPendingApprovals: { method: 'approval/request', verified: true, args: () => ({}) },
  respondApproval: { method: 'approval/respond', verified: false, args: (i) => ({ sessionId: i.sessionId, approvalId: i.approvalId, decision: i.decision, reason: i.reason }) },

  listArtifacts: { method: 'deliverables/presented', verified: true, args: (i) => ({ sessionId: i.sessionId }) },
  readAttachment: { method: 'session/attachment', verified: true, args: (i) => ({ sessionId: i.sessionId, attachmentId: i.attachmentId }) },

  /** 服务端拉取会话事件历史（provider 的轮询式 streamTurns 依赖它） */
  sessionHistory: { method: 'session/history', verified: false, args: (i) => ({ sessionId: i.sessionId, fromSeq: i.fromSeq, limit: i.limit }) },
};

/** 已确认的其它上游能力（M3/M4 用，M0 只登记，不调用） */
export const KNOWN_UPSTREAM = {
  'credentials/describe': { verified: true, purpose: '凭据键名查询' },
  'credentials/set': { verified: true, purpose: '写入凭据' },
  'credentials/unset': { verified: true, purpose: '删除凭据' },
  'agentPresets/list': { verified: true, purpose: '预设列表' },
  'agentPresets/read': { verified: true, purpose: '预设详情' },
  'commands/list': { verified: true, purpose: '斜杠命令列表' },
  'commands/execute': { verified: true, purpose: '执行斜杠命令' },
  'dynamicCordisRunner/inventory': { verified: true, purpose: '动态插件清单' },
  'feedback/record': { verified: true, purpose: '消息反馈（值级失败，需显式判 ok===false）' },
  'fileUploads/upload': { verified: true, purpose: '文件上传' },
  'fileReferences/list': { verified: true, purpose: '文件引用列表' },
  'directoryPicker/list': { verified: true, purpose: '目录列举' },
  'session/search': { verified: true, purpose: '会话搜索（本部署可能返回错误：openAt=never）' },
};

/** 该版本的行为差异（纯函数） */
export const shims = {
  /** 上游会话 id 就是我们记录的 kernel_session_id，不做变换 */
  toKernelSessionId: (id) => String(id),
  /** 会话时间戳统一成 ISO8601 文本 */
  toIso: (v) => (v == null ? null : (typeof v === 'number' ? new Date(v).toISOString() : String(v))),
};

export function report() {
  const entries = Object.entries(UPSTREAM_METHODS);
  const verified = entries.filter(([, v]) => v.verified).map(([k]) => k);
  const unverified = entries.filter(([, v]) => !v.verified).map(([k, v]) => ({ contract: k, bestGuess: v.method }));
  return {
    version: COMPAT_VERSION,
    notes: COMPAT_NOTES,
    mapped: entries.length,
    verified,
    unverified,
    knownUpstream: Object.keys(KNOWN_UPSTREAM),
    howToVerify: '对运行中的内核逐个调用这些方法并录制事件流为 fixtures：确认后把 verified 置 true，'
      + '并在 tools/test-core.mjs 中加断言。未经核实的方法默认被 provider 拒绝调用（可用 STI_ALLOW_UNVERIFIED=1 临时放行）。',
  };
}
