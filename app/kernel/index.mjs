/**
 * 内核装配：决定当前进程用哪个 provider。
 *
 * ── 语义（0.21.4 收敛后）────────────────────────────────────────────────
 * **内核只有两种状态：接入了 / 没接入。** 判据只有一个 —— 配置里有没有地址。
 *
 *   · 有地址 → 用 dsh-provider，并把**这次真实探测的连通状态**如实带出来
 *     （连不上就是连不上，`ready:false` 且 `reason` 说清卡在哪一步）；
 *   · 没地址 → 用 `unconfigured-provider`，所有契约方法抛 `kernel_not_configured`。
 *
 * 这里**曾经**有三个模式（`auto` / `external` / `mock`），其中 `auto` 在探测失败时
 * 会降级到一个内置的确定性内核（mock），让平台"看起来在正常工作"。那一层被
 * 整个删掉了，理由是它把两种完全不同的处境混成了一种：**真的接上了**和
 * **没接上但装作接上了**。用户看到绿色的"平台可用"，却拿不到任何真实回答 ——
 * 而且这件事只有在演示当天才会被发现。现在的行为是直白的：没接入就拦住，
 * 让你去接入（见下方 `ready`）。
 *
 * 平台的身份 / 知识 / 治理等能力**仍然不依赖内核**（这是本平台的承重设计），
 * 所以"没接入"挡住的只有对话本身；挡住这一件事就够了，不必让整个平台起不来。
 *
 * 对外一律用语义名：上游的具体产品名只允许留在 `dsh-provider/` 内。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */
import { createUnconfiguredProvider } from './unconfigured-provider.mjs';
import { createDshProvider } from './dsh-provider/index.mjs';
import { neutralizeUpstreamText } from './dsh-provider/brand.mjs';
import { inspectProvider } from './contract.mjs';
import { versionGate } from '../config.mjs';
import { normalizeKernelInput, diagnoseKernelState } from './connection-config.mjs';
import { log } from '../log.mjs';
import { AppError } from '../util/errors.mjs';

/**
 * 上游状态对象在**交给产品层之前**统一抹一遍名。
 *
 * 为什么必须有这一层：`detail` / `error` / `body` 里装的是**上游原文**（错误体、
 * 异常消息），而 `GET /api/kernel/status` 会把整个状态对象原样放进响应体
 * （`upstreamStatus`）→ 上游名就这么进了浏览器。
 * 放在门面这一层做，而不是在路由里做：这里是**契约层与产品层的唯一交界**，
 * 产品层（app/http）既不该知道"有个上游名需要抹"，也不许 import dsh-provider
 * （它的 import 路径里就带着上游名，分层审计会红）。
 *
 * 幂等：抹过一遍再抹无变化。
 */
function sanitizeStatus(st) {
  if (!st || typeof st !== 'object') return st;
  const out = { ...st };
  for (const k of ['detail', 'error', 'body', 'warning', 'reason', 'server', 'contentType']) {
    if (typeof out[k] === 'string') out[k] = neutralizeUpstreamText(out[k]);
  }
  if (out.facts && typeof out.facts === 'object') {
    const f = { ...out.facts };
    for (const k of ['server', 'contentType']) {
      if (typeof f[k] === 'string') f[k] = neutralizeUpstreamText(f[k]);
    }
    out.facts = f;
  }
  return out;
}

/**
 * 单条内核事件的运行期抹名（0.15.1）。
 *
 * 为什么需要它：**事件的 `text` 字段装的是上游原文** —— 上游会把自己的系统提示词
 * （"You are an AI agent powered by …"，里面带着上游产品全名）、注入的运行时上下文
 * 全都以 `message` 事件回放。这些事件会走两条路到用户眼前：
 * 实时流（`/turns/stream` 的 event 帧）与历史回放（`/sessions/:id/events`）。
 * `sanitizeStatus` 只管状态对象，管不到事件流 —— 静态审计同样看不见这条路径。
 *
 * 与 `sanitizeStatus` 同一条纪律：放在契约层做，产品层既不该知道要抹，
 * 也不许 import dsh-provider。幂等；没有文本字段的原样返回（不复制对象）。
 *
 * ⚠️ 注意分工：**落库仍保留原文**（轨迹是排查上游问题的原料，与"审计锚"同一段
 * 哲学 —— 数据层不许化简），抹名只发生在**服务点**（emit 给前端的帧、读接口）。
 */
export function sanitizeKernelEvent(ev) {
  if (!ev || typeof ev !== 'object') return ev;
  const hasText = typeof ev.text === 'string' && ev.text;
  const hasDelta = typeof ev.delta === 'string' && ev.delta;
  const hasReasoning = typeof ev.reasoning === 'string' && ev.reasoning;
  if (!hasText && !hasDelta && !hasReasoning) return ev;
  const out = { ...ev };
  // reasoning 也要抹：思考过程同样是"要亮给用户的文本"（工作台有专门的折叠区显示它）
  if (hasReasoning) out.reasoning = neutralizeUpstreamText(ev.reasoning);
  if (hasText) out.text = neutralizeUpstreamText(ev.text);
  if (hasDelta) out.delta = neutralizeUpstreamText(ev.delta);
  return out;
}

/**
 * 把 provider 包装成内核门面。HTTP 层只依赖这个门面里的**通用命名**，
 * 因此 app/http/ 与 public/ 里不会出现任何上游专有名词（audit-layering 拦截）。
 *
 * ── 为什么是"可变装配"而不是一组值属性（0.21.3）─────────────────────────
 * 这个对象被**路由表在装配期持有一次**，之后每一次请求都从同一个引用上读。
 * 早先它是一个对象字面量，`mode` / `provider` 都是**值属性**，于是"换内核"
 * 只能靠重启进程重来一遍全装配 —— 页面上因此只能写"保存后需重启生效"。
 *
 * 现在它内部持有 `state`，所有对外字段都是 getter，另有一个 `swap()`。
 * 于是"换内核"= 重新跑一次选型 + 原子写进这个 state：
 *   · 门面引用不变，`deps.kernel` 不用重接、`createServer` 不用重来；
 *   · 所有 `kernel.provider.xxx()` / `kernel.ready` 的调用点**下一行就拿到新值**，
 *     零改动、零遗漏（这也是为什么换成 getter 是这里唯一正确的形状）。
 *
 * ⚠️ 两条配套纪律，缺一个就会出"串线"：
 *   ① 门面内**任何**地方都不许把 `state.provider` 存进闭包 —— 一旦存了，
 *      它就在 swap 之后永远指向旧内核（`describe` / `createUpgradeHandler` /
 *      `forwardRequest` 都曾经是这种写法）。
 *   ② 一个**回合**（submitTurn → streamTurns 循环）内部必须在开头抓一次
 *      provider 局部变量，不能每步重读 —— 否则恰好在两步之间换了内核，
 *      就会出现"用旧内核提交、用新内核收流"。抓一次 = 在途回合用旧内核跑完，
 *      新回合用新内核 —— 这才是**可判定**的语义。
 */
function facade(provider, reason, ready, dshStatus, contract) {
  const state = { ready: !!ready, provider, reason, dshStatus: sanitizeStatus(dshStatus), contract };

  return {
    /**
     * 内核是否**已接入且当前可用**。这是全平台唯一的内核状态判据 ——
     * 前端据此决定"放行"还是"拦住并要求接入"。
     *
     * 刻意不做成三值（`mock` / `external` / `down`）：那三个值里有两个在
     * 用户眼里是一回事（"不能用"），而第三个（mock）本身就是个谎言。
     */
    get ready() { return state.ready; },
    get provider() { return state.provider; },
    get reason() { return state.reason; },
    get dshStatus() { return state.dshStatus; },
    get contract() { return state.contract; },

    describe: () => state.provider.describe(),
    get mapping() {
      return typeof state.provider.mappingReport === 'function' ? state.provider.mappingReport() : null;
    },
    get compat() {
      return typeof state.provider.compatReport === 'function' ? state.provider.compatReport() : null;
    },
    /** 实时流的 upgrade 处理器（无则返回 null，HTTP 层据此不注册） */
    createUpgradeHandler: () => (typeof state.provider.createUpgradeHandler === 'function' ? state.provider.createUpgradeHandler() : null),
    /** 把请求原样转给上游（未接入时抛 not_supported，如实上报） */
    forwardRequest: (req, res, pathname, search) => {
      if (typeof state.provider.forwardRequest !== 'function') {
        throw new AppError('not_supported', '当前内核不提供上游转发', 501);
      }
      return state.provider.forwardRequest(req, res, pathname, search);
    },

    /**
     * 原子换入一份新装配，返回**被换下的旧 provider**。
     *
     * 只覆盖显式给出的字段（`undefined` 一律视为"这次不动它"），所以调用方
     * 想只换 provider、保留 mode 之外的东西也不会被清空。
     *
     * 返回值是旧的 provider 而不是旧的门面：调用方拿它去善后（关文件句柄等），
     * 但它必须**在途回合跑完之后**才允许被真正释放 —— 见配套纪律 ②。
     */
    swap(next = {}) {
      const prev = state.provider;
      if (next.ready !== undefined) state.ready = !!next.ready;
      if (next.provider !== undefined) state.provider = next.provider;
      if (next.reason !== undefined) state.reason = next.reason;
      if (next.dshStatus !== undefined) state.dshStatus = sanitizeStatus(next.dshStatus);
      if (next.contract !== undefined) state.contract = next.contract;
      return prev;
    },

    /** 当前装配快照（只读诊断用；与 status 接口的字段同名，方便对照） */
    get assembly() {
      return {
        ready: state.ready, reason: state.reason,
        status: state.dshStatus, contract: state.contract,
      };
    },
  };
}

/**
 * @param {object} values 来自 config.loadConfig().values
 * @param {{listMcpServers?:(tenantId?:string)=>Array}} [opts]
 *   `opts.listMcpServers` 是**平台 MCP 登记表**的读取器，注入给 provider 用。
 *   为什么内核装配要接收一个平台侧的读表函数：MCP 服务是平台侧配置
 *   （`mcp_servers` 表），上游没有对应的清单 RPC —— 所以"有哪些 MCP 服务"
 *   这个问题只有平台答得出，而契约层 `listMcpServers` 必须答得出来，
 *   否则能力闸（deny 一个 MCP → 契约层立即看不见）**永远没有东西可过滤**。
 *   注入而不是 import：内核适配层不许反向依赖平台层（`architecture.md` §3）。
 *   不传时 provider 如实返回空并说明，不编造。
 * @returns {Promise<object>} 内核门面
 */
export async function selectKernel(values, opts = {}) {
  const providerOpts = {
    origin: values.dshOrigin,
    token: values.dshToken,
    profile: values.dshProfile,
    // 平台 MCP 登记表读取器（见上面的 opts 说明）。undefined 时 provider 如实返回空。
    listMcpServers: opts.listMcpServers,
  };

  // ── 唯一的分叉点：有没有地址 ──────────────────────────────────────────
  // 没有地址就是没接入。这里**不再**退回任何"内置内核"，也不再猜一个默认地址 ——
  // 猜一个出来会造成"我明明没接入，它却说自己好了"的假象。
  if (!providerOpts.origin) {
    const provider = createUnconfiguredProvider();
    log.warn('尚未接入内核（配置里没有内核地址）—— 对话功能不可用，完成接入后即恢复。');
    return facade(provider, '尚未接入内核（配置里没有内核地址）', false, null, inspectProvider(provider));
  }

  // ── 有地址：如实探测，连通与否都算"已接入" ────────────────────────────
  const dsh = createDshProvider(providerOpts);
  let st;
  try {
    st = await dsh.status();
  } catch (e) {
    st = { state: 'unreachable', detail: '探测异常：' + e.message, error: e.message };
  }

  if (st.state === 'ok') {
    log.info('内核已接入（' + st.origin + '，版本 ' + (st.version || '—') + '，rev ' + (st.rev || '—') + '）');
    return facade(dsh, '', true, st, inspectProvider(dsh));
  }

  /**
   * 不可用原因**用产品层的话说**，不是把上游的 state 原样贴给用户。
   *
   * 原先这里是 `'上游内核不可用（' + st.state + '：' + (st.error || st.detail) + '）…'`，
   * 于是界面上出现「上游内核不可用（need-token：DSH 要求浏览器会话鉴权…）」——
   * 两处失真叠在一句话里：① 用户看到的是**机器状态 id** 而不是人话（词表明明就是为了
   * 翻译它才存在的）；② 上游产品名随运行期字符串穿到了用户屏幕上（源码里没有这个字面，
   * 静态审计看不见）。真机验收在概览页上肉眼看到了这句话才抓到。
   * 现在统一从 `diagnoseKernelState` 取「卡在哪一步 + 结论」两段人话。
   */
  const diag = diagnoseKernelState({ state: st.state, detail: st.detail, error: st.error });
  const reason = '内核已配置但当前不可用（' + diag.stage + '：' + diag.verdict + '）。'
    + '平台的身份/知识/治理功能不受影响，但"发起对话"暂时不可用。';
  log.warn(reason);
  return facade(dsh, reason, false, st, inspectProvider(dsh));
}

/**
 * 用一个**调用方给的 provider** 组装内核门面。
 *
 * 存在的理由只有一个：**测试脚手架要注入一个确定性的内核替身**。
 * 产品路径上没有任何地方调用它（产品只有 `selectKernel()` 这一个入口）。
 *
 * 它被导出而不是让测试自己拼一个门面对象，是因为门面里有一堆不显眼的约定
 * （状态抹名、swap 的原子性、getter 而非值属性）—— 测试手抄一份，
 * 抄出来的那份迟早和真门面漂开，而"测试验的是抄的那份"比没有测试更糟。
 *
 * @param {{provider:object, reason?:string, ready?:boolean, status?:object}} x
 * @returns {object} 内核门面
 */
export function createKernel({ provider, reason = '', ready = true, status = null }) {
  return facade(provider, reason, ready, status, inspectProvider(provider));
}

/**
 * 探测一个**还没被采用**的内核地址 —— 接入向导的核心动作。
 *
 * 与 `selectKernel()` 的区别，也是它存在的理由：
 *   · `selectKernel()` 决定"本进程用哪个内核"，在启动时跑一次；
 *   · 这里**只回答"这个地址能不能用"**，不改变任何运行状态、不碰配置文件 ——
 *     所以用户可以放心地"先填一个试试"，试错了不会把正在跑的平台弄坏。
 *
 * 探测顺序是**用户排查问题的顺序**（地址 → 连通 → 鉴权 → 识别 → 版本），
 * 因为用户问的不是"状态机的状态是什么"，而是"我卡在哪一步、下一步该干嘛"。
 * 每一步的结论都来自**真实网络往返**（`status()` 只看 `GET /` 与响应特征，
 * 不依赖任何随版本变动的方法名），没有模拟、没有缓存。
 *
 * @param {{origin?:string, token?:string, profile?:string, timeoutMs?:number}} input
 * @returns {Promise<object>} 诊断结果（**永不含令牌明文**，只报 `hasToken`）
 */
export async function probeKernelConnection(input = {}) {
  const norm = normalizeKernelInput(input.origin, input.token);
  /**
   * ⚠️ 这里**不放 `inputOrigin`**（原始输入串）。
   * 它看着无害，实则是个泄漏通道：用户最常做的就是"把带 ?token=… 的整行粘进来"，
   * 于是原始串里就带着令牌 —— 而这份诊断结果会**原样进 HTTP 响应体**。
   * 归一化后的 `origin` 才是安全的（令牌已经被摘出去了）。
   * 这条是回归逼出来的：`test-core` 里那句"探测结果不得回显令牌"当场抓到了它。
   */
  const base = {
    origin: norm.origin,
    hasToken: !!norm.token,
    tokenSource: norm.tokenFrom,
    reachable: false,
    authed: false,
    httpStatus: '—',
    /** 对面回的 Server / Content-Type —— 排查"这端口上跑的是什么"最直接的两项 */
    server: '—',
    contentType: '',
    version: '',
    rev: '',
  };
  if (norm.invalid) {
    const d = diagnoseKernelState({ state: 'bad-origin', detail: norm.error });
    return { ...base, origin: norm.origin || '', ...d };
  }

  const provider = createDshProvider({
    origin: norm.origin,
    token: norm.token,
    profile: input.profile || 'web',
  });

  let st;
  try {
    const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : 5000;
    st = await provider.status(timeoutMs);
  } catch (e) {
    // status() 自己已经吞了网络异常，走到这里说明是**没预料到的**异常 ——
    // 也按"连不上"如实报，并把原始异常带上（不猜原因）。
    st = { state: 'unreachable', detail: '探测异常：' + e.message, error: e.message };
  }

  // 版本直接取刚拿到的状态里的值 —— **不再调 describe()**：
  // describe() 会再打一次 status()（多一个网络往返）且要解析垫片（读文件系统），
  // 而这些对一个"用户点了按钮在等"的交互式探测都是浪费；`status()` 本来就带了版本。
  const kernelVersion = (st.version && st.version !== '—') ? st.version : '';
  const gate = versionGate(kernelVersion);

  /**
   * ⚠️ 版本号是**本机内核命令行**报的，不是问对面问出来的（上游根路径不返回版本）。
   *
   * 平台按设计与本机内核同机部署时，"本机版本"就是"上游版本"，这个等价关系成立。
   * 但接入向导允许填**任何**地址 —— 一旦填的是另一台机器，这个版本号就只代表
   * "本机能装到的那份"，拿它去说"对方版本已验证"是假陈述。所以跨机时必须明说。
   */
  let versionNote = '';
  try {
    const host = new URL(st.origin || norm.origin).hostname.toLowerCase();
    if (!['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'].includes(host)) {
      versionNote = '版本号读自本机内核命令行，不代表 ' + host + ' 上实际运行的版本 —— '
        + '跨机部署时请以对方为准（本平台的版本门禁只对本机内核有效）。';
    }
  } catch { /* 地址解析不了：上面 bad-origin 已经拦过，这里不再是关注点 */ }
  const d = diagnoseKernelState({
    // ⚠️ 上游回的错误体、上游抛的异常消息都在 detail/error 里 —— 那是**我们控制不了**的文本，
    // 可能带上游名。这份诊断结果会**原样进 HTTP 响应体**并显示在页面上，
    // 所以在契约层的出口**兜底抹一遍名**（第三道防线，见 dsh-provider/brand.mjs）。
    // 前两道是：源码层静态审计 + provider 只报事实不写散文。
    state: st.state,
    detail: neutralizeUpstreamText(st.detail),
    error: neutralizeUpstreamText(st.error),
    versionGate: gate,
  });

  return sanitizeStatus({
    ...base,
    origin: st.origin || norm.origin,
    reachable: !!st.reachable,
    authed: !!st.authed,
    httpStatus: st.httpStatus || '—',
    server: (st.facts && st.facts.server) || '—',
    contentType: (st.facts && st.facts.contentType) || '',
    version: kernelVersion,
    rev: st.rev || '',
    versionNote,
    versionGate: gate,
    ...d,
  });
}

