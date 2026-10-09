/**
 * 上游兼容垫片 · DSH 0.2.0-rc.2
 * ============================================================================
 *
 * ⚠️ 与 0.1.5-rc.2.mjs 的**本质区别**：本表的 `verified` 标记来自
 *    **对运行中 DSH 的实际调用**（tools/verify-upstream.mjs），不是对源码的静态推断。
 *
 * 核实环境（2026-10-01）：
 *   上游       : @deepseek-ai/dsh 0.2.0-rc.2（rev 72da61f1da14）
 *   工具       : node tools/verify-upstream.mjs
 *   已跑通闭环 : 建会话 → 改名 → 选模型 → 发一轮 → 技能清单 → 取消 → 分叉 → 归档
 *
 * ----------------------------------------------------------------------------
 * 静态核查漏掉的两类错误（本文件修的就是它们）
 * ----------------------------------------------------------------------------
 *   ① **方法名猜错**。0.1.5 垫片里 9 个方法名在 0.2.0-rc.2 上全部不存在：
 *        session/submit  session/interrupt  session/dispose  session/history
 *        session/setModel  agents/skills  approval/request  approval/respond
 *        deliverables/presented
 *   ② **参数形状猜错**。真实 DSH 几乎全部要求 `{ request: {…} }` 信封，
 *      而不是裸参数；且 `session/prompt` 的 `content` 必须是**内容块数组**
 *      （`[{type:'text',text}]`），传字符串会得到
 *      `gateway/input-invalid: wire field "request" failed boundary validation`。
 *
 * ----------------------------------------------------------------------------
 * 上游的**两层**接口形态（本文件只覆盖第 1 层）
 * ----------------------------------------------------------------------------
 *   第 1 层 · RPC（HTTP POST /api/<method>）—— 建会话、发回合、改名、选模型…
 *   第 2 层 · Stream（WebSocket /api/<method>）—— `session/follow`（事件流）、
 *            `session/control`（投影基线）、`$events`（审批/提问 waterfall）
 *
 *   ⚠️ 审批、产物**不走 RPC**，它们从事件流里来。
 *      因此 `listPendingApprovals` / `listArtifacts` 在本表里
 *      **如实标注为 stream-sourced**，而不是硬塞一个错误的方法名。
 *      事件流消费见 transport.mjs / events.mjs（P0-C）。
 *
 *   ⚠️ 0.21.10：**"工具清单"不在此列 —— 它根本没有这回事。**
 *      这里从前还登记着 `listTools`（标为 stream-sourced）。用户 2026-10-08 裁定后
 *      整块删除：工具由内核自己调用、上游没有工具清单 RPC，所以"有哪些工具"这个
 *      问题不存在。⚠️ 注意别把它与上面两条混为一谈 —— 审批与产物是**真的能从事件流
 *      取到**（所以标 stream-sourced），工具清单是**取不到也不该取**（所以删除）。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */

export const COMPAT_VERSION = '0.2.0-rc.2';

/**
 * 本上游版本是否支持**图片附件**（随消息一起提交的 image 内容块）。
 *
 * 依据：`@deepseek-ai/dsh-attachment` 在本版本已随 `dsh` 组合默认挂载，
 * `PromptContentPart` 接受 `{type:'image', mediaType, data, name?}`；
 * 本垫片的 `submitTurn` 已把它并进 `content` 块数组。
 *
 * 这个标记**必须由垫片自己声明**，不能让调用方假设：平台层要据此决定
 * "content 里能不能写'已作为图片块提交'"—— 图上不去却这么写，就是假陈述。
 */
export const SUPPORTS_IMAGE_ATTACHMENTS = true;

/**
 * 把契约层的 content（字符串或块数组）+ 图片附件归一为上游要求的内容块数组。
 *
 * 上游 `PromptContentPart` 只接受两种块（`@deepseek-ai/dsh-attachment/lib/types/types.d.ts`）：
 *   { type:'text',  text }
 *   { type:'image', mediaType, data(base64), name? }
 * 而且它明写「a wire caller can **never cite an attachment it did not upload**」——
 * 附件**不是**"先传到某处、再在消息里引用一个 id"，而是**随这一条消息一起过去**。
 * （`readAttachment` / `session/attachment` 是反方向的"读回来"，与写入无关。）
 *
 * 顺序：文本在前、图片在后。文本通常是在描述图，先给上下文再给图；
 * 这也与上游自己的历史投影顺序一致（附件卡跟在消息文本后面）。
 *
 * ⚠️ 只透传 `type === 'image'` 的块，且要求 `mediaType` 与 `data` 都在 ——
 * 上游会因为"字节与声明类型不符"让**整条消息失败**，所以白名单与嗅探在平台侧
 * （`app/platform/attachment/content.mjs`）就做完了，这里不做二次猜测。
 */
function toBlocks(content, attachments) {
  const parts = [];
  if (Array.isArray(content)) {
    parts.push(...content);
  } else if (content != null) {
    parts.push({ type: 'text', text: String(content) });
  }
  for (const a of (Array.isArray(attachments) ? attachments : [])) {
    if (a && a.type === 'image' && a.mediaType && a.data) parts.push(a);
  }
  return parts;
}

/**
 * 回合提交模式归一。
 * ⚠️ 实测（0.2.0-rc.2）：上游只接受 `queue`（排到下一轮）与 `steer`（插到最近的步骤边界）。
 * 传任何别的值（例如平台层习惯写的 `chat`）都会得到
 * `gateway/input-invalid: wire field "request" failed boundary validation` ——
 * 这个报错完全没提"mode"，排查代价很高，所以在**这里**兜住，不指望每个调用方都记得。
 */
const VALID_TURN_MODES = new Set(['queue', 'steer']);
function toMode(mode) {
  const m = String(mode || '').toLowerCase();
  return VALID_TURN_MODES.has(m) ? m : 'queue';
}

/**
 * 契约方法 → 上游 RPC。
 * `verified: true` = 已对运行中的 DSH 实际调用通过。
 * `stream: true`   = 该能力来自事件流，不是 RPC（不在此表映射）。
 */
export const UPSTREAM_METHODS = {
  // ── 会话 ────────────────────────────────────────────────────────────────
  createSession: {
    method: 'session/create', verified: true,
    args: (i) => ({ request: { cwd: i.cwd, ...(i.sessionId ? { sessionId: i.sessionId } : {}), ...(i.presetId ? { agentPreset: i.presetId } : {}) } }),
  },
  listSessions: {
    method: 'session/list', verified: true,
    // ⚠️ 上游接收的是 `{_request:{}}` 这个哨兵形状，不是 `{cursor,limit}`。
    args: () => ({ _request: {} }),
  },
  renameSession: {
    method: 'session/rename', verified: true,
    args: (i) => ({ request: { sessionId: i.sessionId, title: i.title } }),
  },
  forkSession: {
    method: 'session/fork', verified: true,
    args: (i) => ({ request: { sessionId: i.sessionId, atSeq: i.atSeq } }),
  },
  cancelSession: {
    method: 'session/cancel', verified: true,
    args: (i) => ({ request: { sessionId: i.sessionId } }),
  },
  archiveSession: {
    method: 'workspace/archiveSession', verified: true,
    args: (i) => ({ request: { sessionId: i.sessionId } }),
  },
  // disposeSession：上游**无**对应 RPC（`session/dispose` 实测不存在）。
  // 语义上最接近的是归档 —— 由 index.mjs 显式降级，不在此处伪装成 dispose。

  // ── 回合 ────────────────────────────────────────────────────────────────
  submitTurn: {
    method: 'session/prompt', verified: true,
    args: (i) => ({
      request: {
        requestId: i.requestId,
        sessionId: i.sessionId,
        mode: toMode(i.mode),                             // ← 只接受 queue / steer
        content: toBlocks(i.content, i.attachments),     // ← 必须是块数组（图片附件在这里并进去）
        clientTimeZone: i.clientTimeZone || 'UTC',
      },
    }),
  },
  // cancelTurn：上游没有独立的"中断回合"端点（`session/interrupt`/`session/abort`
  // 实测均不存在）。回合级中断复用会话级 `session/cancel`。
  cancelTurn: {
    method: 'session/cancel', verified: true,
    args: (i) => ({ request: { sessionId: i.sessionId } }),
  },

  // ── 模型 ────────────────────────────────────────────────────────────────
  modelCatalog: {
    method: 'session/modelCatalog', verified: true,
    // ⚠️ 0.1.5 垫片映射到了 `llm/listConfigurableProviders` —— 那个端点返回的是
    //    **全部候选供应商**（本机 40 个），不是"真正可路由的"。
    //    基线实现为此专门写过注释说明它会显示"已激活 40/40"与事实相反。
    args: () => ({}),
  },
  selectModel: {
    method: 'session/selectModel', verified: true,
    // ⚠️ 0.1.5 垫片猜的是 `session/setModel` —— 实测不存在。
    //
    // ⚠️⚠️ 参数要求（2026-10-08 用 tools/verify-upstream.mjs 的手法对**运行中的上游**
    //    逐个试出来的，别只看这段注释就改）：
    //      · `request` 信封里 **provider 与 model 必须同时是非空字符串**。
    //        缺 provider、缺 model、或把 provider 写成 `null`，三种都得到**同一句**
    //        `gateway/input-invalid  wire field "request" failed boundary validation` ——
    //        这句话完全不提"是哪个字段"，所以线上排障时极易误判成"上游挂了"。
    //        实测对照：`{sessionId, provider:'deepseek-official', model:'deepseek-flash'}` → OK；
    //        `{sessionId, provider:null, model:'…'}` → input-invalid；缺 provider → input-invalid。
    //      · 所以下面**不把空值写进 request**（写 `provider: null` 与不写是不同的失败信息来源，
    //        但都会失败）——真正的守卫在路由层：给不出 provider 就 400，不把请求发到这里来。
    //      · `reasoningEffort` 可选（省略即用上游默认；实测 'low' / 'high' 都接受）。
    args: (i) => ({
      request: {
        sessionId: i.sessionId,
        ...(i.provider ? { provider: i.provider } : {}),
        model: i.model,
        ...(i.reasoningEffort ? { reasoningEffort: i.reasoningEffort } : {}),
      },
    }),
  },

  // ── 能力清单 ────────────────────────────────────────────────────────────
  listSkills: {
    method: 'skills/list', verified: true,
    // ⚠️ 0.1.5 垫片猜的是 `agents/skills` —— 实测不存在。
    //    返回 { skills: [{ name, description, modelInvocable }] }
    args: (i) => ({ request: { sessionId: i.sessionId } }),
  },
  listPlugins: {
    method: 'pluginInventory/list', verified: true,
    // 返回 { entries: [{ entryId, moduleName, enabled, fiberPhase, meta:{title,description} }] }
    // 注意：这是**插件**清单，不是**工具**清单。
    args: () => ({}),
  },
  listAgentPresets: {
    method: 'agentPresets/list', verified: true,
    args: () => ({}),
  },

  // ── 队列 / 附件 ─────────────────────────────────────────────────────────
  updateQueue: {
    method: 'session/updateQueue', verified: true,
    // 参数形状未逐个核实（探到"存在"，报 arguments-invalid）。
    // 保持映射但标注 partial，调用方需自行确认 args。
    args: (i) => ({ request: { sessionId: i.sessionId, itemId: i.itemId, action: i.action } }),
    partial: true,
  },
  readAttachment: {
    method: 'session/attachment', verified: true,
    // 同上：端点确认存在，args 形状未核实。
    args: (i) => ({ sessionId: i.sessionId, attachmentId: i.attachmentId }),
    partial: true,
  },
};

/**
 * 上游**没有 RPC**、只能从事件流取的能力。
 * 如实登记，供 index.mjs 返回明确的"stream-sourced"状态，
 * 而不是继续映射到一个不存在的方法名（0.1.5 垫片的做法）。
 */
export const STREAM_SOURCED = {
  // ⚠️ 0.21.10：`listTools` 从这里删掉了 —— 连同"工具清单"整个概念。
  //    它登记的事实（上游没有工具清单 RPC）依然成立且是本仓库最硬的一条实测结论，
  //    但结论不再是"改走事件流"，而是"**这件事不存在**"：工具由内核自己调用，
  //    不做清单，所以契约里也不再需要这个方法。
  //    证据留在 `docs/architecture.md` §7.11 与 `0025_drop_tools.sql`。
  listPendingApprovals: '审批来自 $events waterfall（WebSocket），应答走 POST /api/$events/result',
  respondApproval: '同上：POST /api/$events/result { clientId, eventId, outcome }',
  listArtifacts: '产物来自事件流里的 deliverables/presented 事件，不是 RPC',
  sessionHistory: '历史来自 session/follow 流的开屏快照，或 session/page 向后翻页（args 形状未核实）',
  streamTurns: '事件流本身：session/follow（WebSocket）',
};

/**
 * 0.1.5 垫片里被证伪的方法名 —— 留档，避免将来又"想当然"地猜回去。
 */
export const REFUTED_METHODS = {
  'session/submit': '→ 正确为 session/prompt（且 content 必须是块数组）',
  'session/interrupt': '→ 无此端点；回合中断复用 session/cancel',
  'session/dispose': '→ 无此端点；用 workspace/archiveSession 等价',
  'session/history': '→ 无此端点；历史走 session/follow 快照或 session/page',
  'session/setModel': '→ 正确为 session/selectModel',
  'agents/skills': '→ 正确为 skills/list',
  'approval/request': '→ 审批来自 $events 事件流，非 RPC',
  'approval/respond': '→ 应答走 POST /api/$events/result，非 RPC',
  'deliverables/presented': '→ 这是事件类型，不是 RPC 端点',
};

/** 兼容性报告（describe() 与自检页读它） */
export function report() {
  const entries = Object.entries(UPSTREAM_METHODS);
  const verified = entries.filter(([, v]) => v.verified && !v.partial).map(([k]) => k);
  const partial = entries.filter(([, v]) => v.partial).map(([k]) => k);
  return {
    compatVersion: COMPAT_VERSION,
    verifiedBy: 'dynamic（对运行中的内核实际调用）',
    verified,
    partial,
    streamSourced: Object.keys(STREAM_SOURCED),
    refuted: Object.keys(REFUTED_METHODS),
    summary: `RPC ${verified.length} 条已核实 / ${partial.length} 条部分核实；`
      + `另有 ${Object.keys(STREAM_SOURCED).length} 项能力来自事件流（非 RPC），`
      + `${Object.keys(REFUTED_METHODS).length} 个历史方法名已证伪。`,
  };
}

export default { COMPAT_VERSION, SUPPORTS_IMAGE_ATTACHMENTS, UPSTREAM_METHODS, STREAM_SOURCED, REFUTED_METHODS, report };
