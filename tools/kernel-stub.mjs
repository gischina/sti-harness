/**
 * **测试替身**：一个确定性的内核 provider。
 *
 * ⚠️ 这东西**不是产品的一部分**。它住在 `tools/` 下，只被回归脚本显式注入
 * （`createKernel({ provider: createKernelStub() })`），产品代码里没有任何一处引用它。
 *
 * ── 它为什么必须存在 ─────────────────────────────────────────────────────
 * 平台的内核是一个**外部进程**。若回归直接连真内核，会同时失去三件事：
 *   ① 可重复：真模型的输出每轮不同，断言只能写成"大概长得像"；
 *   ② 可离线：CI / 评审机 / 客户现场不一定跑着内核，整套测试会整体 SKIP；
 *   ③ 便宜：每一轮回归都要真花钱调模型。
 * 所以回归需要的是一个**行为确定的替身**：事件流是固定脚本，可以逐条断言。
 *
 * ── 与产品曾经那个 测试替身的区别（这点必须说清）─────────────────────
 * 产品从前有一个"内置内核（测试替身）"，在内核探测失败时**降级**到它，让平台
 * "看起来能正常工作"。那层降级已经删掉了 —— 它把"真接上了"和"没接上但装作
 * 接上了"混成一种状态，用户看到绿色徽章却拿不到真实回答。
 *
 * 这个替身**只作为测试脚手架注入**，产品路径上永远走不到它：
 * 没配地址就是"未接入"（见 app/kernel/unconfigured-provider.mjs），
 * 全平台拦住并要求接入。
 *
 * 它跑的是与真实 provider 完全相同的归一化链路（normalizeEvent），
 * 所以它对契约的遵守程度本身就是一条回归。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { normalizeEvent, CONTRACT_VERSION } from '../app/kernel/contract.mjs';
import { newId, nowIso } from '../app/util/ids.mjs';

/**
 * 事件吐出节奏（毫秒）。真实的 provider 是"逐渐"产出事件的；替身若把整轮事件
 * 一口气同步吐完，流式消费者就永远看不到「首字先到、后续增量到达」这件事，
 * 于是与流式有关的回归会变成"看起来在测、其实什么都没测"。
 * 默认每条间隔 2ms：既不拖慢回归，又让每一帧可被单独观测到。
 * 设 `STI_STUB_PACE_MS=0` 可关闭（例如需要极限吞吐基准时）。
 */
const PACE_MS = Math.max(0, Number(process.env.STI_STUB_PACE_MS != null ? process.env.STI_STUB_PACE_MS : 2));

/** 固定脚本：一轮对话产出的事件序列（deterministic，回归逐条断言用） */
function turnScript(turnId, content, attachments = []) {
  const text = String(content || '').trim() || '(空)';
  const imgs = Array.isArray(attachments)
    ? attachments.filter((a) => a && a.type === 'image' && a.data)
    : [];
  const script = [
    { type: 'turn-start', role: 'user', text },
  ];
  // 图片附件：替身 **不假装看见了图**。
  // 它是确定性脚本，没有视觉能力 —— 如果这里回一句"我看到一张图里有…"，那就是
  // 让回归断言一个不存在的理解力。如实说明"收到了几个什么类型的块"，
  // 既能钉住"平台确实把图片块送到了 provider 这一层"，又不越过它的能力边界。
  if (imgs.length) {
    const detail = imgs.map((a) => {
      let bytes = 0;
      try { bytes = Buffer.from(String(a.data), 'base64').length; } catch { bytes = 0; }
      return a.mediaType + '（' + Math.round(bytes / 1024) + 'KB）';
    }).join('、');
    script.push({
      type: 'message', role: 'assistant',
      delta: '（测试替身）本轮随消息收到 ' + imgs.length + ' 个图片内容块：' + detail
        + '。替身没有视觉能力，不会描述图片内容。',
    });
  }
  script.push(
    { type: 'reasoning', role: 'assistant', delta: '（测试替身）先理解问题。' },
    { type: 'message', role: 'assistant', delta: '（测试替身）收到：' + text },
    { type: 'tool-call', role: 'assistant', tool: { name: 'stub.echo', args: { text }, status: 'running' } },
    { type: 'tool-result', role: 'tool', tool: { name: 'stub.echo', args: { text }, result: text, status: 'ok' } },
    { type: 'message', role: 'assistant', text: '（测试替身）已完成一轮确定性应答。' },
    { type: 'usage', role: 'assistant', usage: { input: 128, cacheRead: 0, cacheWrite: 0, output: 64, reasoning: 16 } },
    { type: 'turn-end', role: 'assistant', text: 'done' }
  );
  return script;
}

export function createKernelStub(opts = {}) {
  /** @type {Map<string, {id,title,cwd,presetId,createdAt,seq,events,listeners:Set}>} */
  const sessions = new Map();

  const get = (sessionId) => {
    const s = sessions.get(sessionId);
    if (!s) { const e = new Error('会话不存在：' + sessionId); e.code = 'session_not_found'; throw e; }
    return s;
  };

  const push = (s, ev) => {
    const normalized = normalizeEvent({ ...ev, seq: ++s.seq, turnId: ev.turnId || null }, { seq: s.seq });
    s.events.push(normalized);
    for (const fn of s.listeners) { try { fn(normalized); } catch { /* 订阅者异常不影响其他订阅者 */ } }
    return normalized;
  };

  const api = {
    name: 'stub',

    /**
     * 图片附件能力。替身 **支持**这条通路（它照单收下图片块并如实回执），
     * 这样回归才能在"没有内核在场"的情况下钉住平台侧的整条链路 ——
     * 否则图片功能的回归只能在接得通上游的机器上跑，等于没有回归。
     */
    imageAttachments: true,

    async describe() {
      return {
        kernel: 'stub',
        /**
         * ⚠️ **空字符串**，不是 `CONTRACT_VERSION`。
         *
         * `kernelVersion` 这个字段回答的是"**上游内核**是哪个版本"。替身没有上游 ——
         * 它就是个本进程里的确定性脚本。从前这里填契约版本（1.0.0），于是版本门禁会报
         * 「1.0.0 不在已验证版本矩阵内」：警告一个**根本不存在的上游版本**。
         * （产品从前靠"内核模式 = mock → 跳过版本门禁"来盖住这件事，0.21.4 那个模式连同
         * 内置内核一起删了。）
         *
         * 现在如实报空 —— 门禁据此得出 `unknown`（"读不到上游版本"），而不是 `warn`。
         * 这条不变式由 test-core「没有上游版本时不得报出上游版本未验证」钉着。
         */
        kernelVersion: '',
        contractVersion: CONTRACT_VERSION,
        protocolVersion: 'stub.deterministic.v1',
        ready: true,
        source: 'kernel-stub',
        detail: '确定性测试替身：不依赖外部内核，输出固定脚本，供自检与回归使用。',
        // ⚠️ 0.21.10：`tools` 字段删除（工具清单这个概念不存在了）。
        //    替身仍会在回合里产生 tool-call / tool-result 事件 —— 那是另一回事。
        skills: [],
      };
    },

    // ── 会话 ──────────────────────────────────────────────
    async createSession({ cwd = '', presetId = null, title = '' } = {}) {
      const id = newId('ks');
      sessions.set(id, {
        id, title: title || '未命名会话', cwd, presetId,
        createdAt: nowIso(), seq: 0, events: [], listeners: new Set(),
        // 本轮起点（见 submitTurn 的说明）。null = 还没提交过回合。
        lastTurn: null,
      });
      return { sessionId: id };
    },

    async listSessions({ limit = 50 } = {}) {
      const items = [...sessions.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((s) => ({
          sessionId: s.id, title: s.title, cwd: s.cwd,
          createdAt: s.createdAt, eventCount: s.events.length,
        }));
      return { items, nextCursor: null };
    },

    async renameSession({ sessionId, title }) {
      get(sessionId).title = String(title || '');
    },

    async forkSession({ sessionId, atSeq = null }) {
      const src = get(sessionId);
      const id = newId('ks');
      const keep = atSeq == null ? src.events.length : Math.max(0, Number(atSeq));
      sessions.set(id, {
        id, title: src.title + '（分叉）', cwd: src.cwd, presetId: src.presetId,
        createdAt: nowIso(), seq: keep, events: src.events.slice(0, keep), listeners: new Set(),
        lastTurn: null,                       // 分叉出来的会话没有"进行中的回合"
      });
      return { sessionId: id };
    },

    async cancelSession({ sessionId }) { get(sessionId); },

    async disposeSession({ sessionId }) { sessions.delete(sessionId); },

    // ── 回合 ──────────────────────────────────────────────
    async submitTurn({ sessionId, requestId = null, content = '', attachments = [] }) {
      const s = get(sessionId);
      const turnId = requestId || newId('kt');
      // 记下**本轮在会话事件数组里的起点**。
      //
      // 为什么必须记（这是一个真实缺陷的修复，不是预防性代码）：
      //   调用方（runTurn）给的 `fromSeq` 是**平台库已落库的最大 seq**。
      //   正常情况下两者相等；但上一轮若被**停止**或**超时**截断，
      //   平台只落了前一半，`fromSeq` 就**小于**上游已产出的事件数。
      //   若拿它当数组下标，本轮就会把上一轮的尾巴当成自己的事件吐出去，
      //   而且会在上一轮的 `turn-end` 处收流 —— 本轮真正的事件反而永远落不了库。
      //   一次停止就能污染此后每一轮，且表现为"答非所问"，极难归因。
      //   （真实 provider 早已用 turnBase 处理这件事，见 dsh-provider/index.mjs；
      //    替身与契约行为不一致本身就是一条缺陷 —— 同一份契约必须同一种语义。）
      s.lastTurn = { turnId, startSeq: s.seq + 1 };
      // 同步产出整段脚本（替身是确定性的，不需要真异步等待）。
      // 图片块原样收下并计入脚本 —— 它的职责是**如实反映收到了什么**，不是理解它。
      for (const ev of turnScript(turnId, content, attachments)) push(s, { ...ev, turnId });
      return { turnId };
    },

    async cancelTurn({ sessionId }) { get(sessionId); },

    /**
     * 流式读取事件。先吐已有的（**本轮**起点之后的），然后挂起等待新事件，
     * 直到遇到 turn-end 或调用方取消 —— 与真实 provider 的行为一致。
     */
    async *streamTurns({ sessionId, fromSeq = 0, signal = null }) {
      const s = get(sessionId);
      // 起点取**两数的较大者**：
      //   · `s.lastTurn.startSeq - 1` —— 本轮的真正起点（唯一正确的那个）；
      //   · `fromSeq`                —— 调用方看到的已落库进度，用于去掉重复。
      // 没走过 submitTurn（例如直接补看历史会话）时 lastTurn 为 null，退回 fromSeq。
      const submitted = s.lastTurn ? s.lastTurn.startSeq - 1 : 0;
      const start = Math.max(0, submitted, Number(fromSeq) || 0);
      let i = s.events.findIndex((e) => Number(e.seq) > start);
      if (i < 0) i = s.events.length;
      let yielded = 0;
      while (true) {
        if (signal && signal.aborted) return;
        if (i < s.events.length) {
          const ev = s.events[i++];
          // 首条立即吐（首字即达），其余按 PACE_MS 间隔 —— 见文件顶部 PACE_MS 说明
          if (yielded > 0 && PACE_MS > 0) await new Promise((r) => setTimeout(r, PACE_MS));
          yielded++;
          yield ev;
          if (ev.type === 'turn-end') return;
          continue;
        }
        // 等待下一条事件
        const next = await new Promise((resolve) => {
          const fn = (ev) => { s.listeners.delete(fn); resolve(ev); };
          s.listeners.add(fn);
          if (signal) signal.addEventListener('abort', () => { s.listeners.delete(fn); resolve(null); }, { once: true });
        });
        if (!next) return;
      }
    },

    async subscribe({ kind, sessionId }) {
      if (kind !== 'turns') return [];
      return get(sessionId).events.slice();
    },

    /** 开屏快照语义：取一次就结束（对齐 Mux.snapshot） */
    async snapshot({ kind = 'turns', sessionId, limit = 200 } = {}) {
      if (kind !== 'turns') return { items: [], kind };
      const s = get(sessionId);
      return { kind, items: s.events.slice(-limit) };
    },

    // ── 模型 ──────────────────────────────────────────────
    async modelCatalog() {
      return {
        groups: [{ provider: 'stub', models: [{ id: 'stub-deterministic', label: '测试替身模型' }] }],
        default: { provider: 'stub', model: 'stub-deterministic' },
        routableProviders: ['stub'],
        failures: [],
        source: 'kernel-stub',
      };
    },

    async selectModel() { /* 替身只有一个模型，接受任意选择 */ },

    async listAgentPresets() {
      // 与真实内核同构的四档（实测 0.2.0-rc.2 `agentPresets/list` 的返回形状：
      // 只有 id/order/isDefault，没有名称与描述 —— 名称是前端显示层的事）。
      // 替身对齐真实形状是为了让回归与真机跑同一条路径，而不是各测各的。
      return {
        presets: [
          { id: 'standard', order: 1, isDefault: true },
          { id: 'ptc', order: 2, isDefault: false },
          { id: 'minimal', order: 3, isDefault: false },
          { id: 'cordis', order: 4, isDefault: false },
        ],
        source: 'kernel-stub',
      };
    },

    // ── 能力清单 ──────────────────────────────────────────
    // ⚠️ 0.21.10：`listTools` 与 describe 里的 `tools` 字段一起删除。
    //    替身从前会报一个内置的 `stub.echo` 工具（脚本回合里模型确实会自发调用它），
    //    但那是**事件流里的事实**（见下面 submitTurn 产生的 tool-call / tool-result），
    //    不是"清单"。本次删除的正是后者 —— 所以 `stub.echo` 这个工具照常被调用、
    //    照常在工具卡里显示，只是不再出现在任何"工具清单"里（那个概念没有了）。
    async listSkills() { return { roots: [], skills: [], source: 'kernel-stub' }; },
    /**
     * 插件清单 —— 替身**如实报"替身下没有插件树"**：`pluginCount` 为 **0** 而不是 null。
     *
     * ⚠️ 为什么必须是 0 而不是 null（0.21.10 修）：契约把这个方法算作必需，
     *    而产品侧那条"插件段要渲染"的断言读的是 `pluginCount` 是不是数字。
     *    替身先前**根本没有这个方法**，路由层 try/catch 吞掉异常后 `pluginCount`
     *    停在 null —— 于是那条断言失败，失败原因却指向"工具段没删干净"，
     *    与真因（契约漏了 `listPlugins`）隔了三层。
     *    替身的职责是"行为确定"，不是"缺什么就让调用方去猜"：没有插件就是 0 个插件。
     */
    async listPlugins() { return { plugins: [], pluginCount: 0, source: 'kernel-stub' }; },
    /**
     * MCP 清单 —— 与真实 provider 同构：来源是**平台登记表**（`mcp_servers`），
     * 上游没有这份清单的 RPC。
     *
     * ⚠️ 这里**必须**接上注入的读取器（`opts.listMcpServers`）。早先它硬编码返回
     *    `servers: []`，后果不是"少一条断言"，而是**能力闸整条路径测不到** ——
     *    gate 拿到的候选恒为空，于是"deny 一个 MCP 服务后契约层立即看不见"
     *    这条验收标准在回归里**永远绿**，而那正是本项目最怕的假绿。
     *    注入方式是 `createKernelStub({ listMcpServers: () => caps.listMcpServersAcrossTenants() })`。
     */
    async listMcpServers() {
      const read = opts.listMcpServers;
      if (typeof read !== 'function') {
        return { servers: [], source: 'kernel-stub', note: '未注入登记表读取器（回归未接线的信号）。' };
      }
      let rows = [];
      try { rows = read() || []; } catch (e) {
        return { servers: [], source: 'kernel-stub', error: e.message };
      }
      return {
        servers: rows.map((r) => ({
          name: r.name, transport: r.transport,
          enabled: r.enabled !== 0 && r.enabled !== false,
          health: r.health || 'unknown',
        })),
        source: 'kernel-stub+platform-registry',
      };
    },

    // ── 审批（回合内模型自发工具调用的审批事件；替身脚本不产生这类事件） ──
    async listPendingApprovals() { return { items: [], source: 'kernel-stub' }; },
    async respondApproval() { /* 替身无待审批项 */ },

    // ── 产物 ──────────────────────────────────────────────
    async listArtifacts() { return { items: [], source: 'kernel-stub' }; },
    async readAttachment() {
      const e = new Error('测试替身不提供附件读取');
      e.code = 'not_supported';
      throw e;
    },

    /** 测试辅助（非契约方法，带下划线前缀因此不算 extra） */
    _sessions: sessions,
    _reset() { sessions.clear(); },
    /** 平台级扩展（通用命名，不含任何上游专有概念） */
    createUpgradeHandler: () => null,
    forwardRequest: () => {
      const e = new Error('测试替身不提供上游转发（没有可转发的上游）');
      e.code = 'not_supported';
      throw e;
    },
  };

  return api;
}
