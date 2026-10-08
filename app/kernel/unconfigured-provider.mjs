/**
 * 「尚未接入内核」的占位 provider。
 *
 * ── 它为什么存在 ─────────────────────────────────────────────────────────
 * 0.21.4 起本平台不再有"内置内核（mock）"这个降级目标：**内核只有接入了和没接入
 * 两种状态**。没接入时 `selectKernel()` 就用这个对象占住 provider 的位置。
 *
 * 为什么不能干脆让 `provider` 为 `null`：门面之外的所有调用点写的都是
 * `kernel.provider.xxx()`（21 个契约方法，散在路由与平台服务里）。给 null 的话
 * 每一处都得先判空 —— 而"忘了判空"的代价是 `TypeError: Cannot read properties of null`，
 * 一个**完全看不出业务含义**的崩溃。占位 provider 把这件事收在一处：
 * 每个方法都抛同一个**带业务语义的错误码** `kernel_not_configured`，
 * 产品层据此就能把用户引到接入页，而不是拿到一个空指针。
 *
 * ── 一条纪律 ─────────────────────────────────────────────────────────────
 * 这里**任何**方法都不许返回"看起来正常的空结果"（比如 `listSessions()` 返回
 * `{items: []}`）。那会让"没接入内核"和"接入了但确实没有会话"变得无法区分，
 * 正是被删掉的那个 mock 降级犯的错。做不到就如实抛错。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { CONTRACT_VERSION } from './contract.mjs';

/** 统一错误码：产品层与前端据此把用户引到接入页（而不是展示成"平台坏了"） */
export const KERNEL_NOT_CONFIGURED = 'kernel_not_configured';

const WHY = '尚未接入内核 —— 请先在管理后台完成内核接入';

function refuse() {
  const e = new Error(WHY);
  e.code = KERNEL_NOT_CONFIGURED;
  throw e;
}

export function createUnconfiguredProvider() {
  return {
    name: 'unconfigured',

    /** 没接入就没有任何附件能力可言（`false` 而非 `undefined`：产品层据此把上传入口关掉） */
    imageAttachments: false,

    async describe() {
      return {
        kernel: 'unconfigured',
        /** 空串而不是造一个版本号 —— 没有上游就没有版本可言 */
        kernelVersion: '',
        contractVersion: CONTRACT_VERSION,
        protocolVersion: 'none',
        ready: false,
        source: 'unconfigured',
        detail: WHY,
        // ⚠️ 0.21.10：`tools: []` 这个字段也删了。它从前与 `skills` 并列，读起来像
        //    "这个内核报了 0 个工具" —— 而事实是**工具没有清单这回事**，
        //    恒空的数组会被读成"一个工具都没有"（与"工具不是可登记对象"是两回事）。
        skills: [],
      };
    },

    // ── 会话 ──────────────────────────────────────────────
    createSession: refuse,
    listSessions: refuse,
    renameSession: refuse,
    forkSession: refuse,
    cancelSession: refuse,
    disposeSession: refuse,

    // ── 回合 ──────────────────────────────────────────────
    submitTurn: refuse,
    cancelTurn: refuse,
    streamTurns: refuse,

    // ── 订阅与快照 ────────────────────────────────────────
    subscribe: refuse,
    snapshot: refuse,

    // ── 模型与模式 ────────────────────────────────────────
    modelCatalog: refuse,
    selectModel: refuse,
    listAgentPresets: refuse,

    // ── 能力清单与审批、产物 ──────────────────────────────
    // ⚠️ 0.21.10：`listTools` 已从契约里删除（工具由内核自己调用、上游也没有工具清单
    //    RPC，所以"有哪些工具"这个问题不存在）。这里与 contract.mjs 的 required
    //    必须**同时**改 —— 少改一处会让 `inspectProvider` 报 missing 或把它算成 extra。
    listSkills: refuse,
    listMcpServers: refuse,
    // 0.21.10：`listTools` 删除、`listPlugins` 补上（与 contract.mjs 的 required 同步改）。
    // 未接入内核时插件树无从谈起 —— 走 `refuse`，与其它能力方法同一语义
    // （抛 `kernel_not_configured`，**不返回"看起来正常的空结果"**）。
    listPlugins: refuse,
    listPendingApprovals: refuse,
    respondApproval: refuse,
    listArtifacts: refuse,
    readAttachment: refuse,

    /** 实时流桥：没接入就没什么可桥接的（返回 null 让 HTTP 层不注册，而不是抛错） */
    createUpgradeHandler: () => null,
  };
}
