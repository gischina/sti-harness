/**
 * DSH provider —— 契约层在 DSH 上的实现。
 *
 * 这是 `AgentKernelContract` 的**唯一**生产实现，也是全项目唯一允许出现
 * DSH 专有名词的目录。产品层通过契约调用它，永远看不到下面的映射表。
 *
 * ── P0-A 之后的变化（2026-10-01）────────────────────────────────────────
 *   1. **垫片按上游版本动态选取**（compat/index.mjs），不再写死一个文件。
 *      版本对不上时如实告警，不再静默用错垫片。
 *   2. 垫片里的 `verified` 标记改由 **对运行中 DSH 的实际调用** 产生
 *      （tools/verify-upstream.mjs），不再是源码静态推断。
 *   3. **历史/增量改从会话日志读**（sessionlog.mjs）。上游没有 `session/history`
 *      这个 RPC；`session/follow` 是 WebSocket，服务端消费它属 P0-C。
 *      日志文件是上游自己写的 append-only 真数据，读它不违反"不落第二份数据"。
 *   4. 审批/产物/工具清单改为如实返回 **stream-sourced** 状态，
 *      不再映射到不存在的方法名然后抛 501。
 *
 * ── 0.19.0 ────────────────────────────────────────────────────────────
 *   5. 模型目录组缺 provider 时按模型 id 命名空间补齐（catalog.mjs，
 *      与基线实现同一取法）；推导不成立的组保持原样如实显示。
 *
 * ── 诚实原则（保持不变）───────────────────────────────────────────────
 *   取不到就说取不到，绝不返回伪造的成功。判据是"这个数据有没有真实来源"，
 *   而不是"调用方会不会不高兴"。
 *
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 */
import crypto from 'node:crypto';
import { createDshClient } from './client.mjs';
import { createWsBridge, forwardHttp } from './transport.mjs';
import { mapUpstreamEvent, eventMappingReport } from './events.mjs';
import { dumpPlugins, skillsRoots, mcpServers } from './capability.mjs';
import { openSessionLog, locateSessionLog } from './sessionlog.mjs';
import { fillGroupProviders } from './catalog.mjs';
import { pickCompat, availableCompatVersions } from './compat/index.mjs';
import { normalizeEvent, CONTRACT_VERSION } from '../contract.mjs';
import { AppError, errors } from '../../util/errors.mjs';
import { log } from '../../log.mjs';

const allowUnverified = () => process.env.STI_ALLOW_UNVERIFIED === '1';

export function createDshProvider(opts = {}) {
  const client = createDshClient(opts);
  const profile = opts.profile || 'web';

  /** 会话 id → 日志句柄（避免每次轮询都重新定位文件） */
  const logs = new Map();
  /**
   * 会话 id → 该会话**本轮提交前**的日志头 seq。
   * 用于把"这一轮新增的事件"从整份日志里切出来。
   * ⚠️ 必须是提交**之前**取，否则会把上一轮的事件也算进来。
   */
  const turnBase = new Map();
  /** 已解析的垫片（惰性，首次调用时解析） */
  let compatState = null;
  let compatPromise = null;

  /**
   * 上游是否支持图片附件（随消息提交的 image 内容块）。
   *
   * 三态，而且**三态都要能说出理由**：
   *   true  —— 已解析垫片，且它声明支持
   *   false —— 已解析垫片，且它声明不支持
   *   null  —— 垫片尚未解析完（**保守按不支持处理**）
   *
   * 为什么要同步属性而不是 `describe()`：平台层在**拼 content 之前**就要知道答案 ——
   * content 里那句"已作为图片块提交给模型"是写给用户看的，图上不去却这么写就是假陈述。
   * 而 `describe()` 是 async（会打网络探测上游），不能塞进这个热路径。
   */
  let imageAttachmentsSupport = null;

  // ── 垫片解析 ──────────────────────────────────────────────────────────

  function ensureCompat() {
    if (!compatPromise) {
      compatPromise = (async () => {
        let version = '';
        try {
          const st = await client.status();
          version = st && st.version && st.version !== '—' ? st.version : '';
        } catch { /* 探测失败就让 pickCompat 挑最新并告警 */ }
        const picked = await pickCompat(version);
        compatState = picked;
        imageAttachmentsSupport = picked.mod.SUPPORTS_IMAGE_ATTACHMENTS === true;
        if (!picked.exact) log.warn('[kernel] ' + picked.warning);
        return picked;
      })();
    }
    return compatPromise;
  }

  // 进程启动即预热垫片：垫片解析只是本地 import + 一次上游版本探测，
  // 而用户的第一轮对话通常在几秒之后。预热能避免"第一次发图正好撞上未解析 → 保守不发"。
  // 失败不致命（首次真正的内核调用会再走一遍 ensureCompat 并如实报错）。
  ensureCompat().catch(() => {});

  /** 同步读已解析的垫片报告；尚未解析时返回 pending（不阻塞同步调用方） */
  function compatReportNow() {
    if (!compatState) {
      return { pending: true, available: availableCompatVersions(), note: '垫片尚未解析（首次内核调用后可用）' };
    }
    const raw = compatState.mod.report ? compatState.mod.report() : {};
    return { ...raw, selected: compatState.version, exact: compatState.exact, warning: compatState.warning };
  }

  /**
   * 调一个已映射的上游 RPC。
   * @param {string} key 契约方法名
   * @param {object} input 契约入参
   */
  async function callMapped(key, input = {}) {
    const { mod } = await ensureCompat();
    const table = mod.UPSTREAM_METHODS || {};
    const entry = table[key];
    if (!entry) {
      const streamNote = (mod.STREAM_SOURCED || {})[key];
      if (streamNote) {
        throw new AppError('contract_method_stream_sourced',
          `契约方法 ${key} 在上游没有对应 RPC —— ${streamNote}`, 501);
      }
      throw new AppError('contract_method_unmapped',
        `契约方法 ${key} 尚未映射到上游 RPC（请在该版本的 compat 文件里补一条）`, 501);
    }
    if (!entry.verified && !allowUnverified()) {
      throw new AppError('unverified_upstream_method',
        `上游方法名 ${entry.method}（契约方法 ${key}）尚未对着运行中的内核核实，已拒绝调用。`
        + '核实后请把 compat 里的 verified 置为 true；确需临时放行可设 STI_ALLOW_UNVERIFIED=1。', 501);
    }
    return client.remoteCall(entry.method, entry.args(input));
  }

  // ── 事件归一 ──────────────────────────────────────────────────────────

  /** 把上游原始事件数组归一化 */
  function normalizeList(list, sessionId, turnId = null) {
    const out = [];
    let seq = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      const mapped = mapUpstreamEvent(raw);
      out.push(normalizeEvent(mapped, { seq: ++seq, turnId }));
    }
    return out;
  }

  /** 该会话的日志句柄（缓存） */
  function logFor(sessionId, cwd = '') {
    let h = logs.get(sessionId);
    if (!h) {
      h = openSessionLog(sessionId, cwd);
      logs.set(sessionId, h);
    }
    return h;
  }

  /** 从会话日志读出归一化事件（外部模式下历史与增量的真实来源） */
  function readHistoryFromLog(sessionId, cwd, { afterSeq = 0 } = {}) {
    const h = logFor(sessionId, cwd);
    if (!h.available) {
      return { events: [], available: false, note: '会话日志未找到（上游可能尚未写入，或换过 DSH_HOME）' };
    }
    const r = h.readAfter(afterSeq);
    return {
      events: normalizeList(r.rows, sessionId),
      available: true,
      frames: r.frames, torn: r.torn, note: r.note || '',
    };
  }

  // ── provider ─────────────────────────────────────────────────────────

  const api = {
    name: 'external',

    /**
     * 图片附件能力（同步读）。
     * 用 getter 而不是普通属性：垫片是**异步**解析的，快照一个布尔值会在
     * "解析完成"与"读取"之间产生一个永远为 false 的窗口（第一轮对话就发不了图）。
     */
    get imageAttachments() { return imageAttachmentsSupport === true; },

    // ── 能力探测 ────────────────────────────────────────────
    async describe() {
      const st = await client.status();
      const picked = await ensureCompat();
      return {
        kernel: 'external',
        kernelVersion: st.version && st.version !== '—' ? st.version : 'unknown',
        contractVersion: CONTRACT_VERSION,
        compatBaseline: picked.version,
        compatExact: picked.exact,
        protocolVersion: 'external-kernel/compat-' + picked.version,
        ready: st.state === 'ok',
        source: 'external-kernel',
        detail: st.detail,
        state: st.state,
        origin: st.origin,
        rev: st.rev,
        warning: st.state === 'ok' ? '' : (st.error || st.detail),
        compatWarning: picked.warning,
        tools: [],
        skills: [],
        // 图片附件能力：自检页与 describe() 都要能看到，否则"图上不去"这件事
        // 就只藏在一次被跳过的调用里，没人查得出来。
        imageAttachments: imageAttachmentsSupport === true,
        mapping: eventMappingReport(),
        compat: compatReportNow(),
        streamTurns: 'log-tail（历史与增量读上游会话日志；上游 WS 事件流消费属 P0-C）',
      };
    },

    status: (t) => client.status(t),
    probe: (t) => client.probe(t),
    dumpPlugins: () => dumpPlugins(client, profile),
    skillsRoots: () => skillsRoots(),
    mappingReport: () => eventMappingReport(),
    compatReport: () => compatReportNow(),
    client,
    compat: () => compatState,

    /** 平台级扩展：给 HTTP 层用的**通用**传输接口（不含任何 DSH 命名） */
    createUpgradeHandler: () => createWsBridge({ client }),
    forwardRequest: (req, res, pathname, search) => forwardHttp(req, res, { client, pathname, search }),

    // ── 会话 ──────────────────────────────────────────────
    async createSession(input = {}) {
      // 上游接受客户端预铸的 sessionId（基线实现亦如此）；自己铸一个，
      // 这样返回值不依赖上游是否回显 id。
      const wanted = input.sessionId || ('sti-' + crypto.randomUUID());
      const v = await callMapped('createSession', { ...input, sessionId: wanted });
      const sessionId = (v && (v.sessionId || v.id)) || wanted;
      return { sessionId: String(sessionId) };
    },

    async listSessions(input = {}) {
      const v = await callMapped('listSessions', input);
      const items = (v && Array.isArray(v.items) ? v.items : []).map((s) => ({
        sessionId: String(s.sessionId || s.id || ''),
        title: (s.projections && s.projections.values && s.projections.values.title) || s.title || '',
        cwd: s.cwd || '',
        running: !!s.running,
        blank: !!s.blank,
        updatedAt: s.updatedAt != null ? new Date(s.updatedAt).toISOString() : null,
        projections: s.projections || null,
      }));
      return { items, nextCursor: null, source: 'external-kernel' };
    },

    async renameSession(input) { return await callMapped('renameSession', input); },
    async forkSession(input) { return await callMapped('forkSession', input); },
    async cancelSession(input) { return await callMapped('cancelSession', input); },

    /**
     * 上游**没有** dispose 端点（`session/dispose` 实测不存在）。
     * 语义上最接近的是归档 —— 如实降级，并把这件事写进返回里，
     * 而不是假装 dispose 成功了。想真正删掉需在 DSH 侧操作。
     */
    async disposeSession(input) {
      const r = await callMapped('archiveSession', { sessionId: input && input.sessionId });
      logs.delete((input && input.sessionId) || '');
      return { archived: true, note: '上游无 dispose 端点，已按归档处理（会话文件仍在上游磁盘）', upstream: r ?? null };
    },

    // ── 回合 ──────────────────────────────────────────────
    async submitTurn(input = {}) {
      const sessionId = input.sessionId;
      // 先记下提交前的日志头 —— 这是"本轮新增事件"的起点。
      // 若日志此刻还不存在，记 0，streamTurns 会在文件出现后从头取（新会话本来就该从头取）。
      try {
        const h = logFor(sessionId, input.cwd || '');
        turnBase.set(sessionId, h.available ? h.headSeq() : 0);
      } catch { turnBase.set(sessionId, 0); }

      const requestId = input.requestId || ('req-' + crypto.randomUUID());
      const v = await callMapped('submitTurn', { ...input, requestId });
      // 上游回 { accepted: true }（实测），不回 turnId —— 用本地 requestId 作为回合标识
      return { turnId: requestId, accepted: !!(v && v.accepted !== false), upstream: v ?? null };
    },

    async cancelTurn(input) { return await callMapped('cancelTurn', input); },

    /**
     * 服务端事件流：**读会话日志的增量**（tail 语义）。
     *
     * 为什么不是 WebSocket：上游的实时推送是 WS，而服务端的 WS 消费需要自己解帧
     * （P0-C）。日志文件同样是上游写的真数据，且天然支持"从头补历史 + 追增量"，
     * 因此在不引入 WS 的情况下就能给出正确的流语义。
     */
    async *streamTurns({ sessionId, cwd = '', fromSeq = 0, signal = null, intervalMs = 400 }) {
      // ⚠️ 这里**刻意不认**传入的 fromSeq。
      // 契约层传的是平台库的事件数，而本 provider 要的是上游日志的 seq —— 两套编号。
      // 正确起点由 submitTurn 记下的 turnBase（提交前的日志头）提供。
      // 只有在没走过 submitTurn（例如直接补看某个历史会话）时，才把 fromSeq 当日志 seq 兜底。
      const base = turnBase.get(sessionId);
      let cursor = base != null ? base : (fromSeq > 0 ? fromSeq : 0);
      const maxIdleMs = 10 * 60 * 1000;      // 10 分钟无新事件则收流，避免悬挂
      const startedAt = Date.now();
      let sawAny = false;
      while (true) {
        if (signal && signal.aborted) return;
        const h = logFor(sessionId, cwd);
        if (h.available) {
          const r = h.readAfter(cursor);
          for (const raw of r.rows) {
            const seq = typeof raw.seq === 'number' ? raw.seq : cursor + 1;
            if (seq <= cursor) continue;
            cursor = seq;
            sawAny = true;
            const ev = normalizeEvent(mapUpstreamEvent(raw), { seq, turnId: null });
            yield ev;
            if (ev.type === 'turn-end') return;
          }
        }
        if (Date.now() - startedAt > maxIdleMs) return;
        // 还没见过任何事件时用更短的间隔，让首字尽快出来
        await new Promise((r) => setTimeout(r, sawAny ? intervalMs : Math.min(intervalMs, 150)));
      }
    },

    async subscribe({ kind, sessionId, cwd = '', fromSeq = 0 }) {
      if (kind !== 'turns') return [];
      return readHistoryFromLog(sessionId, cwd, { afterSeq: fromSeq }).events;
    },

    async snapshot({ kind = 'turns', sessionId, cwd = '', limit = 200 } = {}) {
      if (kind !== 'turns') return { kind, items: [], source: 'external-kernel' };
      const r = readHistoryFromLog(sessionId, cwd, { afterSeq: 0 });
      return {
        kind,
        items: r.events.slice(-limit),
        source: 'external-kernel/session-log',
        logAvailable: r.available,
        ...(r.available ? { frames: r.frames, torn: r.torn } : { note: r.note }),
      };
    },

    /** 诊断：该会话日志实际出现的事件类型（排查映射缺漏用） */
    async logTypes({ sessionId, cwd = '' }) {
      const h = logFor(sessionId, cwd);
      return h.available ? { file: h.file, types: h.types() } : { file: null, types: [] };
    },

    // ── 模型 ──────────────────────────────────────────────
    async modelCatalog() {
      const v = await callMapped('modelCatalog', {});
      // 上游组常缺 provider（旧版垫片只透传不补）。模型 id 自带命名空间
      // （`provider/model`）是这条上游的真实事实 —— 组内唯一时据此补齐（catalog.mjs）；
      // 推导不成立的组保持原样，前端如实显示「未知来源」。
      return {
        groups: fillGroupProviders((v && v.groups) || []),
        default: (v && v.default) || null,
        routableProviders: (v && v.routableProviders) || [],
        failures: (v && v.failures) || [],
        source: 'external-kernel',
      };
    },
    async selectModel(input) { return await callMapped('selectModel', input); },

    // ── 能力清单 ──────────────────────────────────────────
    async listSkills(input = {}) {
      try {
        const v = await callMapped('listSkills', { sessionId: input.sessionId });
        const skills = (v && Array.isArray(v.skills) ? v.skills : []).map((s) => ({
          name: s.name, description: s.description || '', modelInvocable: !!s.modelInvocable,
        }));
        return { ...skillsRoots(), skills, source: 'external-kernel' };
      } catch (e) {
        // 上游会话不可用时仍返回本地技能根，但如实带上错误
        return { ...skillsRoots(), skills: [], source: 'external-kernel', error: e.message };
      }
    },

    /**
     * 插件清单（0.21.10）。
     *
     * ⚠️ 这个方法**从前叫 `listTools`**，挂在契约的"能力清单"一族里 —— 但它
     * **从来就没有返回过工具**：上游没有工具清单 RPC，所以它从前恒返回 `tools: []`，
     * 真正有内容的只有 `plugins` 那半边（来自 `pluginInventory/list`，给的是**插件**）。
     * 一个名字叫工具、内容全是插件的方法，是"概念没对齐"的典型症状。
     *
     * 0.21.10 遂用户裁定（「工具是在内核自己调用，不用单独写这个能力，
     * 而且不会单独列出来有哪些工具」）把"工具清单"整个概念删掉，同时把这里
     * **正名为它实际在做的事**：报插件。方法名与返回值都对齐到 `plugins`。
     *
     * ⚠️ 为什么不连插件一起删：插件是**真实可枚举**的（上游 `pluginInventory/list`
     *    有 RPC，实测返回 200），它和"工具"不是一回事 —— 插件是装进来的扩展包，
     *    工具是内核在回合内的一次调用。删前者会顺手删掉一份真的能拿到的清单。
     *
     * ⚠️ 这条查询**不抛错**：没有工具清单 RPC 是"上游没这个能力"，不是"没映射"，
     *    所以从前不抛 501 —— 那个取舍对插件同样成立（拿不到插件树不该让整页崩）。
     */
    async listPlugins() {
      let plugins = null;
      try {
        plugins = await callMapped('listPlugins', {});
      } catch { /* 取不到就保持 null，不编 */ }
      return {
        source: 'external-kernel',
        pluginCount: plugins && Array.isArray(plugins.entries) ? plugins.entries.length : null,
        plugins: plugins && Array.isArray(plugins.entries)
          ? plugins.entries.filter((e) => e.enabled).map((e) => ({
            entryId: e.entryId, moduleName: e.moduleName,
            title: (e.meta && e.meta.title) || e.moduleName,
            description: (e.meta && e.meta.description) || '',
          }))
          : [],
      };
    },

    // ⚠️ 平台 MCP 登记表读取器由装配层注入（见 kernel/index.mjs 的 selectKernel）。
    //    没注入时 `mcpServers()` 如实返回空并说明 —— 不编造一份清单。
    async listMcpServers() { return mcpServers(opts.listMcpServers); },

    /** 代理预设清单（契约可选扩展，产品层的会话创建向导会用到） */
    async listAgentPresets() {
      const v = await callMapped('listAgentPresets', {});
      return { presets: (v && v.presets) || [], source: 'external-kernel' };
    },

    // ── 审批（回合内模型自发工具调用的审批，全部来自事件流，非 RPC）──────
    async listPendingApprovals() {
      return {
        items: [], source: 'external-kernel', streamSourced: true,
        note: '审批来自上游 $events 事件流（WebSocket），由上游在回合内处置，平台侧从事件流事后可见。',
      };
    },
    async respondApproval() {
      throw new AppError('contract_method_stream_sourced',
        '审批应答走上游事件通道（POST /api/$events/result，需 WS clientId），不是 RPC。', 501);
    },

    // ── 产物（来自事件流，非 RPC）──────────────────────────
    async listArtifacts() {
      return {
        items: [], source: 'external-kernel', streamSourced: true,
        note: '产物来自事件流里的 deliverables/presented 事件，非 RPC；平台侧产物见 /api/governance/artifacts',
      };
    },
    async readAttachment(input) { return await callMapped('readAttachment', input); },
  };

  return api;
}
