/**
 * 上游事件 → KernelEvent 的**唯一**映射点。
 *
 * 这是整个项目对抗「上游升级导致字段静默变空」的核心防线：
 * 上游字段名只允许出现在本文件里；落库 schema 用的是自己的语义字段名。
 * 上游改名 → 只改这里（feasibility §6.3 / §6.4）。
 *
 * ── 上游有**两个**不同的事件面，别混淆 ────────────────────────────────
 *
 *  A. 持久化会话日志（durable journal）
 *     物理位置：`~/.dsh/sessions/<projectKey>/<sessionId>/session.vN.jsonl.zstd`
 *     —— **拼接的 zstd 帧容器**：首帧是 header 行（`type:'session'`），其后每帧一个事件批次。
 *     权威词汇表 = `@deepseek-ai/dsh-session` 的 `SessionEventMap`（14 个核心类型），
 *     已固化为可自动比对的快照 `upstream-contract.snapshot.json`。
 *     **但真实日志里的类型更多**（插件自有事件，如 `session/title`、`sandbox/mode`），
 *     这部分只有录制真实事件流才看得到 —— 见 `fixtures/`。
 *
 *  B. 实时流（live wire）
 *     基线实现对接的那一层，含 `assistant/chunk` 这类增量帧。
 *     这些**不在** SessionEventMap 里（不是持久化事件），但确实会出现在流上。
 *
 * ── 真实信封（已由录制的事件流确认，见 fixtures） ─────────────────────
 *
 *   { type, seq, time, data, surfaceOp? }
 *
 *   · `seq`  ：number，从 0 开始、连续 → 我们**直接沿用**，便于与上游日志对账
 *   · `time` ：number（毫秒时间戳）→ 映射成我们的 ISO `at`
 *   · `data` ：**业务字段全在这里**（不是顶层！）
 *   · `surfaceOp`：可选，'append' 之类，表示该事件对"模型可见表面"的操作
 *
 * ── 三个已由真实事件流确认、且都曾会静默失败的点 ─────────────────────
 *
 *  1. `message.content` 是**内容块数组** `[{type:'text', text:'…'}, …]`，不是字符串。
 *     用 `String(v)` → "[object Object]"（假内容）；只认字符串 → 文本**全丢**（更隐蔽）。
 *  2. `TokenUsage.inputTokens` 是**未缓存输入**，不是总输入。上游注释原文：
 *     "Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 *      reported separately as cacheReadTokens/cacheWriteTokens (billed input = sum of
 *      the three)."
 *  3. `turn/end.data.reason` 是**对象** `{kind:'completed'}`，不是字符串。
 *     另外：上游**没有独立的 usage 事件** —— 用量挂在 `assistant/message.data.usage`。
 *
 * ── 诚实标注 ─────────────────────────────────────────────────────────
 *
 * 每条规则都带 `source`：
 *   'live@0.2.0-rc.2'        — 已由**录制下来的真实事件流**确认（最强，见 fixtures/）
 *   'types@0.2.0-rc.2'       — 已由上游类型定义确认（可按快照自动复核）
 *   'baseline'               — 已由基线实现（同权利人早期作品）的既有代码确认
 *   'guess'                  — **尚未核实**
 * `_verified` 是 `source !== 'guess'` 的简写；`eventMappingReport()` 会暴露全部，
 * 并给出「对上游日志事件类型（含插件事件）的覆盖率」——升级后覆盖率下降即上游加了新事件。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { EVENT_TYPES } from '../contract.mjs';
import { readSnapshot } from './upstream-contract.mjs';

/** 从任意嵌套里取第一个存在的值（上游形状在版本间会挪位置，用别名单一收口） */
function firstOf(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const k of p.split('.')) {
      if (cur == null || typeof cur !== 'object' || !(k in cur)) { ok = false; break; }
      cur = cur[k];
    }
    if (ok && cur != null) return cur;
  }
  return undefined;
}

/**
 * 只在确实是标量时转字符串。
 * ⚠️ 不做 `String(对象)` —— 那会产出 "[object Object]" 这种**看起来像内容其实是垃圾**的值。
 * 宁可返回 null（界面显示"无文本"），也不要伪造一段假内容。
 */
const asText = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
};

/**
 * 从「内容块数组」抽纯文本。
 *
 * ⚠️ 上游的 `message.content` / `user/message.data.content` 是
 * `[{ type:'text', text:'…' }, …]` 的**块数组**（已由真实事件流确认）。
 * 这块必须显式展开：
 *   · 用 `String(v)` 会得到 "[object Object]" —— 假内容；
 *   · 只认字符串会把文本**全部丢掉** —— 而且不报错，更难发现。
 * 非文本块（图片等）没有 `text` 字段，跳过；全部跳过则返回 null（不编造）。
 */
function contentText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const parts = [];
    for (const b of v) {
      if (b && typeof b === 'object') {
        const t = asText(b.text);
        if (t != null) parts.push(t);
      } else {
        const t = asText(b);
        if (t != null) parts.push(t);
      }
    }
    return parts.length ? parts.join('\n') : null;
  }
  if (typeof v === 'object') return asText(v.text);
  return asText(v);
}

/** 文本候选路径（**先 content 块数组，再标量**；顺序即优先级） */
const TEXT_PATHS = [
  'data.message.content', 'data.content', 'message.content', 'content',
  'data.text', 'text', 'delta', 'data.delta',
];

/**
 * 把上游 content **块数组**按块类型拆开（0.15.1 真机审计抓出）。
 *
 * 上游的 `assistant/message.content` 形如
 *   `[{type:'reasoning', text:'…思考…'}, {type:'text', text:'…正文…'}, {type:'tool-call', …}]`
 * —— 实证见 `app/kernel/fixtures/dsh-0.2.0-rc.2-session.json`。
 * 此前 `contentText()` 把**所有**块的 text 拼成一个字符串塞进 `text`，
 * 于是模型的思考过程被当成答案正文亮在工作台上：用户先看到一段英文自我推演，
 * 然后答案混在其中 —— 数据没错，但没法看。
 *
 * 拆开后：`text` 只装正文块；`reasoning` 装思考块 —— 工作台本来就有一个
 * "思考过程"折叠区，只是一直没人喂过它。工具调用块不在这里展开（它们有自己的映射）。
 *
 * @returns {{text:string|null, reasoning:string|null}} 没有可拆的块数组时返回 null（调用方退回老路径）
 */
function splitContentBlocks(v) {
  if (!Array.isArray(v)) return null;
  const texts = [];
  const thinks = [];
  for (const b of v) {
    const t = (b && typeof b === 'object') ? asText(b.text) : asText(b);
    if (t == null) continue;
    if (b && b.type === 'reasoning') thinks.push(t);
    else texts.push(t);
  }
  return {
    text: texts.length ? texts.join('\n') : null,
    reasoning: thinks.length ? thinks.join('\n') : null,
  };
}

function pickText(raw) {
  const v = firstOf(raw, TEXT_PATHS);
  return v === undefined ? null : contentText(v);
}

// ── 信封字段 ──────────────────────────────────────────────────────────

/** 上游事件序号（从 0 开始、连续）。**直接沿用**，便于与上游日志逐条对账。 */
export function upstreamEventSeq(raw) {
  const s = firstOf(raw, ['seq', 'data.seq']);
  return s != null && Number.isFinite(Number(s)) ? Number(s) : null;
}

/** 上游事件时间（毫秒时间戳）→ ISO 字符串；拿不到返回 null（不编造当前时间充当事件时间） */
export function upstreamEventTime(raw) {
  const t = firstOf(raw, ['time', 'timestamp', 'at']);
  if (t == null) return null;
  if (typeof t === 'string' && Number.isNaN(Number(t))) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;   // 秒级时间戳也能吃下
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── usage 抽取 ────────────────────────────────────────────────────────

/** 语义字段 ← 上游候选名。**已核实**的放前面，跨版本猜测的排后面（命中即用）。 */
const USAGE_ALIASES = {
  input: ['inputTokens', 'uncachedInputTokens', 'input', 'promptTokens', 'prompt_tokens'],
  cacheRead: ['cacheReadTokens', 'cacheReadInputTokens', 'cache_read_input_tokens'],
  cacheWrite: ['cacheWriteTokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens'],
  output: ['outputTokens', 'output', 'completionTokens', 'completion_tokens'],
  reasoning: ['reasoningTokens', 'reasoning'],
};

/** 上面每个字段里，**哪些别名已由上游类型定义确认**（其余属于跨版本猜测） */
const USAGE_VERIFIED_ALIASES = {
  input: ['inputTokens', 'uncachedInputTokens'],
  cacheRead: ['cacheReadTokens'],
  cacheWrite: ['cacheWriteTokens'],
  output: ['outputTokens'],
  reasoning: ['reasoningTokens'],
};

/**
 * 抽 usage。
 * 额外做一次**交叉校验**：上游 `totalTokens` 定义为「全部 prompt + output」，
 * 若分项之和与之不符，说明我们对字段的理解与实际不一致 —— 此时**不改数值**（不猜），
 * 而是回一个 `usage_total_mismatch` 警告，让问题浮到界面与审计里。
 */
function extractUsage(raw) {
  const src = raw && raw.data && typeof raw.data === 'object' ? { ...raw, ...raw.data } : raw;
  const u = {};
  let any = false;
  for (const [field, aliases] of Object.entries(USAGE_ALIASES)) {
    for (const a of aliases) {
      // 同一别名同时试"顶层"与 `usage.` 前缀两种位置：
      // 持久化日志是 `{…, data:{usage:{…}}}`，wire 帧则常把数字摊平在顶层。
      const v = firstOf(src, [a, 'usage.' + a]);
      if (v != null && Number.isFinite(Number(v))) {
        u[field] = Number(v);
        any = true;
        if (!USAGE_VERIFIED_ALIASES[field].includes(a)) u._guessedAliases = [...(u._guessedAliases || []), a];
        break;
      }
    }
  }
  if (!any) return null;

  const total = firstOf(src, ['totalTokens', 'usage.totalTokens']);
  if (total != null && Number.isFinite(Number(total))) {
    const sum = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0);
    if (sum !== Number(total)) u._totalMismatch = { reported: Number(total), computedFromParts: sum };
  }
  return u;
}

/** 把 usage 里以 `_` 开头的诊断信息转成 warnings 数组 */
function usageWarnings(u) {
  const w = [];
  if (!u) return w;
  if (u._totalMismatch) {
    w.push('usage_total_mismatch(' + u._totalMismatch.computedFromParts + '≠' + u._totalMismatch.reported + ')');
  }
  if (u._guessedAliases && u._guessedAliases.length) {
    w.push('usage_alias_guessed(' + u._guessedAliases.join('|') + ')');
  }
  return w;
}

const toolName = (raw) => asText(firstOf(raw, ['data.name', 'name', 'tool.name', 'toolName', 'data.toolName'])) || '';

/**
 * 工具调用的**配对 id**（0.21.10 新增）。
 *
 * 上游两侧的字段名不同：`tool/call` 是 `data.callId`，
 * `tool/result` 是 `data.message.toolCallId`（同一个值）。两个都收，
 * 因为这是**唯一**能把一次调用与它的结果对上号的凭据 ——
 * 名字只能"大概率对上"，同一轮调同名工具两次就错配了（见 tool-result 的 note）。
 *
 * 取不到就返回 `null`（而不是空串）：`null` 的含义是"上游没给配对凭据"，
 * 与"给了个空 id"是两件事 —— 前端据此决定"退回按名字配对"而不是"按空串配对"。
 */
const toolCallId = (raw) => asText(firstOf(raw, [
  'data.callId', 'callId', 'data.message.toolCallId', 'message.toolCallId', 'toolCallId', 'data.toolCallId',
]));

/**
 * 上游**插件自有**的日志事件类型（白名单）。
 *
 * 它们不在 `SessionEventMap` 里（那是核心词汇表），由各插件拥有 data 形状。
 * 这里**不猜其语义**，统一折叠成 `lifecycle` 并保留原始类型名 ——
 * 这样轨迹页能显示"这里有一条插件事件"，而**真正的未知类型仍会落成 unknown**。
 * 用白名单而不是通配，正是为了保住这个区分能力。
 *
 * 来源：录制自 `@deepseek-ai/dsh@0.2.0-rc.2` 的真实会话日志（见 fixtures/）。
 */
export const PLUGIN_EVENT_TYPES = [
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'agent/inbox/spliced',
  'session/title',
  'session/title-llm-request',
  'session-log-deepseek/delivery-accepted',
  'subagent/catalog',
  'workspace/changes',
];

/** 少数插件事件携带**有治理/展示价值**的标量，值得提出来（其余一律不提，不猜） */
const PLUGIN_SCALAR = {
  'permission/preset': 'data.preset',
  'sandbox/mode': 'data.mode',
  'approval/policy': 'data.policy',
  'session/title': 'data.title',
};

/**
 * 映射规则表。顺序即优先级（先匹配者胜）。
 * `test` 接收归一化后的上游类型串（统一成小写、保留 '/' 与 '-'）。
 * `map(raw, t)` 的第二个参数是归一化后的类型串。
 */
export const EVENT_RULES = [
  // ── A. 持久化日志：生命周期骨架（显式识别，避免冒充"未知事件"） ──────
  {
    id: 'step-start',
    source: 'live@0.2.0-rc.2',
    note: '一步开始（一次模型调用 + 它请求的工具执行）。对模型可见轨迹无贡献。',
    test: (t) => /^step[\/.]start$/.test(t),
    map: () => ({ type: 'lifecycle', kind: 'step-start', role: 'system' }),
  },
  {
    id: 'step-end',
    source: 'live@0.2.0-rc.2',
    test: (t) => /^step[\/.]end$/.test(t),
    map: () => ({ type: 'lifecycle', kind: 'step-end', role: 'system' }),
  },
  {
    id: 'request-header',
    source: 'live@0.2.0-rc.2',
    note: '下一次请求的完整头（log-only，不参与请求重建）。',
    test: (t) => /^request[\/.](header|context)$/.test(t),
    map: (raw, t) => ({ type: 'lifecycle', kind: /context/.test(t) ? 'request-context' : 'request-header', role: 'system' }),
  },
  {
    id: 'session-end-seed',
    source: 'types@0.2.0-rc.2',
    note: '继承/恢复历史与后续工作的分界标记（fork 场景）。',
    test: (t) => /^session[\/.]end-seed$/.test(t),
    map: () => ({ type: 'lifecycle', kind: 'session-end-seed', role: 'system' }),
  },
  {
    id: 'plugin-lifecycle',
    source: 'live@0.2.0-rc.2',
    note: '插件自有的日志事件（白名单见 PLUGIN_EVENT_TYPES）。不猜语义，只折叠 + 保留原始类型名。',
    test: (t) => PLUGIN_EVENT_TYPES.includes(t),
    map: (raw, t) => {
      const path = PLUGIN_SCALAR[t];
      const extra = path ? asText(firstOf(raw, [path])) : null;
      return { type: 'lifecycle', kind: 'plugin:' + t, role: 'system', ...(extra ? { text: extra } : {}) };
    },
  },

  // ── A. 持久化日志：turn / 消息 ────────────────────────────────────
  {
    id: 'turn-start',
    source: 'live@0.2.0-rc.2',
    test: (t) => /^turn[\/.]start$/.test(t) || /turn.*(start|begin)|run.*start/.test(t),
    map: (raw) => ({ type: 'turn-start', role: 'user', text: pickText(raw) }),
  },
  {
    id: 'turn-end',
    source: 'live@0.2.0-rc.2',
    note: '⚠️ 上游 `reason` 是对象（形如 {kind}，实测 kind 取值为 completed），不是字符串。'
      + '早期实现直接对 reason 取文本会得到 null，于是"为什么结束"这一信息静默丢失。',
    test: (t) => /^turn[\/.]end$/.test(t) || /turn.*(end|finish|stop)|run.*(end|finish)|^done$/.test(t),
    map: (raw) => {
      const kind = asText(firstOf(raw, ['data.reason.kind', 'data.reason', 'reason.kind', 'reason']));
      return { type: 'turn-end', role: 'assistant', text: 'done', kind: kind ? 'reason:' + kind : null };
    },
  },
  {
    id: 'user-message',
    source: 'live@0.2.0-rc.2',
    note: '用户输入（也包含 agent 注入的上下文，靠 source 字段区分；此处不细分）。',
    test: (t) => /^user[\/.]message$/.test(t),
    map: (raw) => ({ type: 'message', role: 'user', text: pickText(raw) }),
  },
  {
    id: 'system-message',
    source: 'live@0.2.0-rc.2',
    test: (t) => /^system[\/.]message$/.test(t),
    map: (raw) => ({ type: 'message', role: 'system', text: pickText(raw) }),
  },
  {
    id: 'developer-message',
    source: 'types@0.2.0-rc.2',
    note: '开发者在会话中途追加的指令（会话级变更），语义上归入 system。',
    test: (t) => /^developer[\/.]message$/.test(t),
    map: (raw) => ({ type: 'message', role: 'system', text: pickText(raw) }),
  },
  {
    id: 'assistant-attempt',
    source: 'types@0.2.0-rc.2',
    note: '一次没有产生可见消息的模型尝试（失败/重试/取消）。'
      + '对轨迹有价值（能看出重试），所以单独给一个 kind 而不是丢进 unknown。',
    test: (t) => /^assistant[\/.]attempt$/.test(t),
    map: () => ({ type: 'lifecycle', kind: 'assistant-attempt', role: 'assistant' }),
  },
  {
    id: 'assistant-message',
    source: 'live@0.2.0-rc.2',
    note: '一步的完整助手消息（派生历史用的就是它）。'
      + '用量在这里（`data.usage`）——上游没有独立的 usage 事件。'
      + '`interrupted:true` 表示流被打断的前缀。'
      + 'content 块按类型拆分（reasoning/text，见 splitContentBlocks）——'
      + '0.15.1 真机审计抓出：此前思考过程会被当成答案正文显示。',
    test: (t) => /^assistant[\/.]message$/.test(t),
    map: (raw) => {
      const u = extractUsage(raw);
      const interrupted = firstOf(raw, ['interrupted', 'data.interrupted']);
      const split = splitContentBlocks(firstOf(raw, [
        'data.message.content', 'data.content', 'message.content', 'content',
      ]));
      return {
        type: 'message',
        role: 'assistant',
        // 没有块数组（或全是非文本块）时退回老路径 —— 老行为对"纯标量 text"的上游依旧成立
        text: split ? split.text : pickText(raw),
        reasoning: split ? split.reasoning : null,
        usage: u,
        warnings: usageWarnings(u),
        kind: interrupted ? 'interrupted' : null,
      };
    },
  },

  // ── A. 持久化日志：工具 ───────────────────────────────────────────
  {
    id: 'tool-call',
    source: 'live@0.2.0-rc.2',
    note: '字段名已实测确认：`callId` / `name` / `arguments`'
      + '（arguments 是原始 JSON 字符串，上游未解析——我们原样保留，不擅自 parse）。'
      + '`callId` 现在**真的取出来了**（放进 `callId`），见下面 tool/result 的 ⚠️。',
    test: (t) => /^tool[\/.](call|use|invoke)/.test(t),
    map: (raw) => ({
      type: 'tool-call',
      role: 'assistant',
      tool: {
        name: toolName(raw),
        args: firstOf(raw, ['data.arguments', 'arguments', 'data.args', 'args', 'input']) ?? null,
        status: 'running',
        callId: toolCallId(raw),
      },
    }),
  },
  {
    id: 'tool-result',
    source: 'live@0.2.0-rc.2',
    note: '⚠️ 字段名曾经搞错过：上游是 `data.message`（ToolResultMessage），'
      + '不是 `result`。早期版本只找 result/output，于是工具结果会静默变空。'
      + '失败标记是 `data.message.isError`（boolean），另有 `data.error.name/code`。'
      + ''
      + '⚠️ **`tool/result` 里没有工具名**（0.21.10 抓出）。真事件形状是：'
      + '  tool/call   → { callId, name, arguments }'
      + '  tool/result → { message: { toolCallId, content, isError } }'
      + '名字只在 call 那一侧。此前 `toolName(raw)` 在这里一路取空 → `name: \'\'`，'
      + '而前端靠**名字相等**把 result 并回 call 那张卡（84-workbench.js）——'
      + '空名对不上任何卡，于是每轮都**凭空多出一张「(未命名工具)」孤儿卡**，'
      + '而且同一轮调同名工具两次时第二个 result 会误并到第一张卡上。'
      + '真上游一直给着 `toolCallId`，它与 call 侧的 `callId` 配对，'
      + '所以这里把它取出来、`name` 取不到就**如实留空**，交给前端按 id 配对。',
    test: (t) => /^tool[\/.](result|output|response)/.test(t),
    map: (raw) => {
      const err = firstOf(raw, ['data.error', 'error']);
      const isErr = firstOf(raw, ['data.message.isError', 'message.isError']);
      // 失败有两种标记来源：message.isError（权威）与 error（失败身份+原因）。任一存在即为失败。
      const isError = isErr === true || !!err;
      const content = firstOf(raw, ['data.message.content', 'message.content']);
      return {
        type: 'tool-result',
        role: 'tool',
        text: contentText(content),
        tool: {
          name: toolName(raw),
          result: firstOf(raw, ['data.message', 'message', 'data.result', 'result']) ?? null,
          status: isError ? 'error' : 'ok',
          callId: toolCallId(raw),
        },
        ...(isError ? { warnings: ['tool_result_is_error'] } : {}),
      };
    },
  },

  // ── B. 实时流（wire）：不在 SessionEventMap 里，但确实会出现在流上 ──
  {
    id: 'compaction',
    source: 'baseline',
    note: '上下文压缩。基线实现已把 compaction/start|summary|end 折叠成单一节点。',
    test: (t) => /^compaction[\/.]/.test(t),
    map: () => ({ type: 'message', role: 'system', text: '[上下文已压缩]' }),
  },
  {
    id: 'assistant-chunk',
    source: 'baseline',
    note: '流式增量帧（wire 层）。持久化日志里没有它——那里是 assistant/message.data.stream。',
    test: (t) => t === 'assistant/chunk' || /assistant.*chunk/.test(t),
    map: (raw) => ({ type: 'message', role: 'assistant', delta: asText(firstOf(raw, ['delta', 'text', 'data.delta', 'data.text'])) }),
  },
  {
    id: 'reasoning',
    source: 'guess',
    note: '推理增量。上游 SessionEventMap 无此类型；推理内容实际藏在 '
      + 'assistant/message.data.stream 的帧里（`[{type,time,chunk}]`）。'
      + '保留本规则是为了兼容可能直接发这类帧的内核/插件，名称本身未核实。',
    test: (t) => /reason|thinking|analysis/.test(t),
    map: (raw) => ({ type: 'reasoning', role: 'assistant', delta: asText(firstOf(raw, ['delta', 'text', 'data.delta', 'data.text'])) }),
  },
  {
    id: 'approval',
    source: 'baseline',
    note: '审批请求（上游由 user-approval 相关插件负责，非核心日志事件）。',
    test: (t) => /approval/.test(t),
    map: (raw) => ({ type: 'approval', role: 'system', tool: { name: toolName(raw) } }),
  },
  {
    id: 'usage',
    source: 'guess',
    note: '独立用量事件。上游 0.2.0-rc.2 没有它（用量挂在 assistant/message 上）。'
      + '保留是因为我们自己的契约里有这个类型：测试替身会发，未来其它内核也可能发。',
    test: (t) => /usage|token/.test(t),
    map: (raw) => {
      const u = extractUsage(raw);
      return { type: 'usage', role: 'assistant', usage: u, warnings: usageWarnings(u) };
    },
  },
  {
    id: 'error',
    source: 'guess',
    test: (t) => /error|fail|abort/.test(t),
    map: (raw) => ({ type: 'error', role: 'system', text: pickText(raw) }),
  },
];

/** 归一化上游类型串（不改变语义，只统一大小写与分隔符） */
function normType(raw) {
  const t = firstOf(raw, ['type', 'event', 'kind', 'name']);
  if (t == null) return '';
  return String(t).trim().toLowerCase().replace(/_/g, '-');
}

/**
 * 把一条上游原始事件映射成接近 KernelEvent 的形状。
 * 未识别的类型**不丢弃**：返回 {type:'unknown', known:false, _upstreamType}，
 * 这样轨迹页仍能看到"这里有一条本版本不认识的事件"，并可在 fixtures 里补规则。
 */
export function mapUpstreamEvent(raw) {
  const t = normType(raw);
  if (!t) return { type: 'unknown', known: false, _upstreamType: '', _ruleId: null, _source: null };

  for (const rule of EVENT_RULES) {
    let hit = false;
    try { hit = rule.test(t); } catch { hit = false; }
    if (!hit) continue;
    const mapped = rule.map(raw, t) || {};
    mapped._ruleId = rule.id;
    mapped._upstreamType = t;
    mapped._source = rule.source || 'guess';
    mapped._verified = mapped._source !== 'guess';
    if (!mapped.type) mapped.type = 'unknown';
    // 信封字段顺带带出来，调用方（provider）可直接沿用上游序号与时间
    const sq = upstreamEventSeq(raw);
    if (sq != null) mapped._upstreamSeq = sq;
    const tm = upstreamEventTime(raw);
    if (tm != null) mapped._upstreamTime = tm;
    return mapped;
  }

  return { type: 'unknown', known: false, _ruleId: null, _source: null, _upstreamType: t };
}

/** 读一次上游契约快照（用于算覆盖率）。读不到就返回 null，绝不因此报错。 */
let _snapshotCache;
function journalTypes() {
  if (_snapshotCache === undefined) {
    const s = readSnapshot();
    _snapshotCache = s && s.sessionEventTypes ? Object.keys(s.sessionEventTypes) : null;
  }
  return _snapshotCache;
}

/**
 * 映射覆盖率报告 —— 状态页与自检用，让"哪些还没核实"一目了然。
 *
 * 两个覆盖率，含义不同：
 *   · `journalCoverage` —— 对**类型定义**里的 14 个核心日志事件，我们认得出几个；
 *   · `liveCoverage`    —— 对**真实录制到的事件流**里的全部类型（含插件事件），我们认得出几个。
 * 后者更强（它是上游真正会发的东西）；上游升级后这个数字若下降，说明它加了新事件。
 */
export function eventMappingReport() {
  const bySource = (s) => EVENT_RULES.filter((r) => (r.source || 'guess') === s);
  const verified = EVENT_RULES.filter((r) => (r.source || 'guess') !== 'guess');
  const unverified = EVENT_RULES.filter((r) => (r.source || 'guess') === 'guess');

  const jt = journalTypes();
  const covered = jt ? jt.filter((t) => mapUpstreamEvent({ type: t }).type !== 'unknown') : null;
  const uncovered = jt ? jt.filter((t) => mapUpstreamEvent({ type: t }).type === 'unknown') : null;

  return {
    ruleCount: EVENT_RULES.length,
    verified: verified.map((r) => r.id),
    unverified: unverified.map((r) => ({ id: r.id, note: r.note || '' })),
    bySource: {
      'live@0.2.0-rc.2': bySource('live@0.2.0-rc.2').map((r) => r.id),
      'types@0.2.0-rc.2': bySource('types@0.2.0-rc.2').map((r) => r.id),
      'baseline': bySource('baseline').map((r) => r.id),
      guess: unverified.map((r) => r.id),
    },
    knownTypes: EVENT_TYPES.slice(),
    journalEventTypes: jt,
    journalCoverage: jt ? { total: jt.length, covered: covered.length, uncovered } : null,
    journalCoverageNote: jt
      ? null
      : '未找到上游契约快照（app/kernel/dsh-provider/upstream-contract.snapshot.json）——'
        + '跑 `node tools/snapshot-upstream-contract.mjs --update` 生成后即可算出覆盖率。',
    pluginEventTypes: PLUGIN_EVENT_TYPES.slice(),
    note: 'source=guess 的规则尚未对着运行中的上游核实；'
      + '核实后应把真实事件流录制为 fixtures（tools/record-fixtures.mjs）并钉进回归。',
  };
}

export const _internals = { normType, extractUsage, firstOf, asText, contentText, pickText, usageWarnings, journalTypes };
