/* STI HARNESS 前端 · 前端状态（唯一真源）
 * Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
 *
 * 本文件是前端按域拆分后的一片。全部片由 public/index.html **按顺序**加载，
 * 且都是经典脚本（非 ES module）—— 它们共享同一个全局作用域，因此彼此可以直接引用，
 * 不需要 import、不需要任何构建步骤（`node --check` 与回归里的 `vm` 都能直接跑）。
 * 加载顺序即依赖顺序；拆分依据与边界见 docs/architecture.md §7.8。
 */
'use strict';
/* ── 状态 ─────────────────────────────────────────────── */
const State = {
  view: 'boot',        // boot | setup | login | app
  setup: null,         // GET /api/identity/setup
  me: null,            // GET /api/identity/me
  // 两步登录第二步（TOTP）：口令已过、还没完成登录时的 {ticket, expiresAt}。
  // 有它 = 登录页画第二阶段（验证码输入）；null = 普通登录/应用内。见 50-boot.js pageLogin。
  mfa: null,
  totp: null,          // GET /api/identity/totp（我的两步验证状态；密钥/恢复码不在其中）
  status: null,
  routes: null,
  contract: null,
  middleware: null,
  users: null,
  roles: null,
  groups: null,        // GET /api/identity/groups
  departments: null,   // GET /api/identity/departments（组织归属，**非权限载体**）
  creds: null,
  apikeys: null,
  /* ── 知识库（M2）── */
  kbStatus: null,      // GET /api/knowledge/status
  bases: null,         // GET /api/knowledge/bases
  currentBase: null,   // 当前选中的知识库 id
  documents: null,     // 当前库的文档列表
  // 库级授权名单（§B9）。形状 `{ kbId, ok, items }` 或 `{ kbId, ok:false, reason, status }`：
  //   · `ok:false` 是**一种正常结果**（"你在本库没有 write 档"），不是异常 —— 必须和"未加载"区分开，
  //     否则页面只能显示一个含糊的"读不到"。
  //   · 带 `kbId` 是因为切库时旧名单会短暂留在内存里；渲染端据此判断"这份名单是不是当前库的"。
  baseGrants: null,
  grantSubjectType: 'user', // 授权表单：当前选的主体类型（成员 / 用户组）
  chunks: null,        // 当前预览的文档分块
  previewDoc: null,
  search: null,        // 最近一次检索结果
  /* ── 治理与审计（M3）── */
  auditData: null,     // GET /api/governance/audit
  auditVerify: null,   // POST /api/governance/audit/verify 的最近一次结果
  quotasData: null,    // GET /api/governance/quotas
  usageData: null,     // GET /api/governance/usage
  // 成本估算（P1-3）：**独立的**一份数据源，不与 usageData 合流 ——
  // usage 是"事件照抄的 token 数"（可核对），cost 是"token × 当前单价"（估算）。
  // 混在一起，页面上就分不清哪个数能拿去对账。
  costData: null,      // GET /api/governance/cost
  // 会话日志页（0.18.0）：会话清单（GET /api/kernel/sessions）。
  // 三种状态必须区分：null=还没拉到；{noSessionRead:true}=有 artifact:read 但没有 session:read
  // （不是错误，是权限差 —— 页面上要如实说明）；{error}=真失败。
  sessionLogsData: null,
  /* ── 能力分发（M4）── */
  capSkills: null,     // GET /api/capability/skills（registry + kernel 双来源）
  capMcp: null,        // GET /api/capability/mcp
  capPolicies: null,   // GET /api/capability/policies（三级 allow/deny 绑定）
  capExport: null,     // 最近一次导出的清单（展示用）
  /* ── 备份与恢复（P0-D 补页）── */
  backupList: null,    // GET /api/operation/backup（已存在的备份文件）
  backupResult: null,  // 最近一次创建的备份结果
  backupVerify: null,  // 最近一次校验结果
  /* ── 模型中心（P1-1）── */
  models: null,        // GET /api/model/providers（条目 + 降级链 + 状态）
  modelKind: 'chat',   // 新建表单当前选中的用途（决定协议下拉可选值）
  modelProbe: null,    // 最近一次探活的两层结论
  /* ── 调度与通知（P1-2）── */
  schedules: null,     // GET /api/schedule/jobs（任务清单 + 调度器状态）
  scheduleRun: null,   // 最近一次手动执行的结论
  notifyData: null,    // GET /api/notify/channels（渠道 + 状态）
  notifyTest: null,    // 最近一次试发结果
  deliveries: null,    // GET /api/notify/deliveries（失败重投队列，§B5）
  /* ── 对话工作台（P0-B）── */
  // 与后台各页互不干扰：工作台有自己的会话列表、消息流与增量状态。
  // 所有字段都在这里显式初始化，避免"某条路径下读取 undefined"。
  wb: {
    loaded: false,     // 是否已拉过一次会话列表与模型目录
    loading: false,
    // 是否**至少成功跑完过一次** wbEnsureLoaded（0.21.9）。
    // 与 `loaded` 分开是必须的：`wbInvalidate()` 会把 loaded 置回 false（知识库增删后
    // 下次进工作台要整体重拉），那时界面上**已经有**上一份数据，不该整块退回"加载中"。
    // `ready` 只说一件事：这一屏是不是**还没拿到过任何数据**。
    // 它存在的理由见 84-workbench.js 里 wbTreeHtml / pageWorkbench 的中间态说明。
    ready: false,
    sessions: [],      // GET /api/kernel/sessions
    sessionId: null,   // 当前会话
    msgs: [],          // 消息与回合（含流式增量）
    models: [],        // 扁平化的模型选项 [{provider,id,label}]
    modelValue: '',    // 选中项，形如 "provider|model"
    streaming: false,  // 是否正在流式接收
    abort: null,       // 当前流的 AbortController
    // 右侧面板（上下文面板：当前会话的用量与产物）是否展开。
    //
    // 演化（后一次是用户 2026-10-08 的裁定，别把中间那版当设计）：
    //   0.21.2 起 = `false`（默认收起）—— 当时的理由是与原生 Harness 第一屏一致：
    //              一进来只有树和输入卡，上下文用右上 ▤ 随时开；
    //   0.21.9 起 = `true`（默认展开）—— 用户原话：「右侧栏 上下文面板 默认显示」。
    //
    // 为什么这次翻过来（也是这次反弹的根因）：那一栏装的是**当前会话的事实**
    // （用量 / 产物），而"这个会话跑掉了多少 token、产出了什么"恰恰是用户**一进来
    // 就想知道**的东西。默认收起等于把这条事实藏在一个纯图标钮后面 ——
    // 图标钮没有文字，不知道要点它的人永远不会点，于是那一栏等于不存在。
    // 收起的默认值只对"内容多到碍事"的面板才成立，这一栏不属于那种。
    //
    // 仍然是**开合记忆不落盘**：刷新后回到这个默认值。没做持久化是有意的 ——
    // 默认值一旦可被旧偏好覆盖，这份"默认应该是什么"的判断就再也改不动了。
    railOpen: true,
    // ── 会话框里的选项卡（0.21.9，用户 2026-10-08 二次裁定）───────────────
    // 'chat' = 对话正文；'trace' = 轨迹（推理 / 知识库回执 / 工具卡 / 附件回执 / 用量 / 原始事件）。
    //
    // 为什么要有它：轨迹从前**长在消息流里**跟着对话走，于是"这一轮的正文"与
    // "这一轮背后的动作"混在同一条竖轴上 —— 工具卡一多，正文就被挤到看不见。
    // 拆开是对的；拆完之后**放在哪**被用户否过一次，别把中间那版当设计：
    //   0.21.8 及以前   = 混在消息流里；
    //   0.21.9 第一版   = 挪到**右栏**的第二个 tab（那时叫 `railTab`）；
    //   0.21.9 定版     = 挪回**主区**，成为会话框自己的选项卡。
    //   用户原话：「轨迹不要放到右侧栏，放到会话框中（会话框中选项卡对话、轨迹）」。
    //   右栏那版的问题很实在：轨迹是**这个会话的内容**，而右栏装的是"会话旁边的材料"
    //   （用量、产物）—— 把会话的一部分挪到会话外面，读起来就成了两个不相干的东西。
    // 默认停在 chat：那是"看回答"的位置，也就是用户按下发送之后要看的东西。
    viewTab: 'chat',
    usage: null,       // 当前会话用量汇总（GET /api/kernel/sessions/:id）
    // 本会话**已在库里登记**的模型（来自会话详情）。与 `modelValue`（下拉当前选项）分开存：
    // 下拉在目录里找得到已登记模型时会同步指过去（见 wbRefreshContext），
    // 徽标仍显示服务端记下的原值 —— 目录缺该选项时不强选，如实保留。
    modelRecorded: '',
    modelRecordedProvider: '',
    artifacts: null,   // 当前会话产物（需要 artifact:read）
    error: '',         // 加载类错误（与单条消息的错误分开）
    notice: '',
    seq: 0,            // 本地消息 id 计数器
    // ── 3.6 工作台最后一公里 ──────────────────────────────
    lastTurnId: null,  // 本轮上游回合 id —— 「停止」时要把它带上去，否则取消的是"某个回合"
    attachmentList: [],// 本会话已上传的附件（服务端为准）
    attachPicked: [],  // 本轮选中要发的附件 id
    attachBusy: false, // 上传中
    attachError: '',
    // ⚠️ 0.21.7 删掉了 searchQ / searchBusy / searchResult / searchError 四个字段 ——
    //    「会话内检索」整块删除（用户裁定）。连带删掉的是服务端
    //    `/api/kernel/sessions/:id/search` 路由、命中浮层与消息卡上的命中高亮。
    // ── 0.14.0 会话挂载知识库（RAG）────────────────────────
    kbList: [],        // 当前用户**可见**的知识库（GET /api/knowledge/bases，已按库级 ACL 过滤）
    kbLoaded: false,   // 是否已拉过可见库列表（与 `loaded` 分开：列表可能因权限变化而需要重拉）
    kbPicked: [],      // 新建会话时要挂的库 id（仅在"还没建会话"时有效）
    kbPanelOpen: false,// 知识库选择面板是否展开
    kbBusy: false,     // 挂载请求进行中
    kbError: '',       // 挂载失败原因（与列表加载失败分开说）
    // ── 可用能力（右栏只读）──────────────────────────────
    // 与知识库条同一纪律：按权限拉取，没权限段如实不显示。
    // ⚠️ 0.21.10：`caps`（GET /api/capability/skills）这个字段删了 ——
    //    它在工作台里唯一的读者是"工具卡的来源对账徽标"，而对账随工具登记表一起删除。
    //    一次没有消费者的请求不该继续跑在每次进工作台的路径上。
    //    ⚠️ 别与 `State.capSkills`（**能力清单页**自己的加载）混为一谈，那个还在用。
    capsMcp: null,     // GET /api/capability/mcp → {registry, kernel}
    capsLoaded: false, // 是否已拉过一次（skills 与 mcp 合用一个闸，都是同批加载）
    capsError: '',     // 读取失败原因（与「无权限不显示」分开）
    // ── 0.21.0 工作区树（0.21.6 起是纯组织容器）──────────────
    wsLoaded: false,   // 是否已拉过一次工作区树
    wsError: '',
    workspaces: [],    // GET /api/workspaces → items（id / name / cwd / 会话数 / isDefault）
    defaultWorkspaceId: '',  // 兜底工作区（isDefault）的 id —— 删工作区时会话落进它
    wsOpen: {},        // 树节点展开状态 {'wsp-xxx': true}
    wsActiveId: null,  // 「新对话」要建进的工作区。点树上工作区行 / 建会话时定下
    // ⚠️ 0.21.9 删掉了 `ungroupedCount`（以及树上那个「未分组」桶）。
    //    未分组 = `workspace_id IS NULL`，它不是一条工作区记录 —— 删不掉、改不了名、
    //    也不在 workspaces 表里，却在权限上是一条**暗门**（服务端对它直接 can:true）。
    //    现在：删工作区时会话落进**默认工作区**（isDefault），存量空归属会话由迁移 0024
    //    一次性归位，服务端启动时再对账一遍。见 app/platform/workspace/service.mjs。
    // ⚠️ 0.21.6 删掉了 grantRoles / levelLabels / wsGrants / wsUsers / wsGroups 五个字段 ——
    //    它们只服务于"工作区三档授权"那一套界面，而那套已整体删除
    //    （理由见 app/platform/workspace/visibility.mjs 头注释：
    //     上游 dsh 自己有一份工作区权限三档，平台这份改了不生效）。
    // 0.21.9：模式（preset）整块从界面拿掉（用户裁定），于是这里四个字段全部删除 ——
    //    presets / presetsLoaded / presetValue（新对话要用的模式）/ presetRecorded（本会话登记的）。
    //    ⚠️ 删的是**界面状态**，不是事实：`preset_id` 那一列仍在库里、会话详情仍回报 `presetId`。
    //       哪天要放回来，判据是"界面上有没有模式" —— 有就恢复这四个，没有就别留半截。
    effort: '',        // 推理等级（模型目录 reasoning.efforts 的 id）；有会话时切换即登记
    treeFilter: '',    // 侧栏过滤词（过滤工作区名与会话标题）
    treeFilterOpen: false, // 过滤输入框是否展开（节头的放大镜切换；默认收起 —— 与原生 Harness 一致，
                       // 一进来先看到树本身，而不是一排控件）
    sideOpen: true,    // 左栏是否展开（品牌头的收起钮；0.21.2 全屏布局）。
                       // ⚠️ 收起后由**左侧竖排入口栏**（`.wb-siderail`）里的 `wb-side-expand` 负责展开。
                       //    0.21.7 修的是"收起来就展不开"：收起钮住在 `.wb-side` 里，会被
                       //    `display:none` 一起藏掉；0.21.8 又把那颗孤钮换成了一整列 ——
                       //    因为左栏底部那三个入口（管理后台 / 设置 / 我的账号）同样住在栏里，
                       //    收起时跟着一起消失，等于收起左栏就把治理面导航整个丢了。
    // 行内「⋯」菜单（0.21.1）：`{kind:'ws'|'session', id}`，同时只开一个。
    // 为什么做成状态而不是"在 DOM 里插一个浮层"：与全站同一套渲染模型 ——
    // 重绘即真相、回归里的 DOM 垫片能直接驱动它（见 40-delegate.js 文件头）。
    rowMenu: null,
    // ⚠️ 0.21.11：工作台的 `accountMenu` 已删 —— 左栏账号条回退成"只显示用户名、
    //    点了跳我的账号"（用户裁定），不再有下拉，也就不需要这个状态。
    //    顶栏那个下拉用的是**顶层** `State.topbarMenu`，与这里无关。
  },
  /* ── 内核接入向导（P0）── */
  // 把"手改 data/config.json 再重启"变成页面上三步：填地址 → 检测 → 保存。
  //
  // 表单值刻意放在**状态**里而不是读 DOM：检测完要重绘一张诊断卡，重绘会重建输入框，
  // 那时读 DOM 只能拿到空值 —— 用户刚粘进去的地址会凭空消失。
  // 令牌只在内存里过一手，保存成功后立刻清掉（它已经加密落到服务端了）。
  // ⚠️ 没有 `force` 这一项：0.21.5 起保存**必须以检测通过为前提**，
  // 那个「跳过检测直接保存」的勾选框连同它的状态一起删了（见 kernelFormHtml 的说明）。
  kernelForm: { origin: '', token: '' },
  kernelStatus: null,    // GET /api/kernel/status（含 restart：配置改了但还没生效）
  kernelProbe: null,     // POST /api/system/kernel/probe 的返回（stage/verdict/detail/hint）
  kernelProbeBusy: false,
  kernelProbeError: null,
  kernelSaving: false,
  kernelSaved: null,     // POST /api/system/kernel/config 的返回
  kernelSaveError: null,
  // 应用内对话框（见 15-dialog.js）。null = 没有弹层。
  // **它是状态**（而不是随手往 DOM 里插节点）的理由见 15-dialog.js 文件头：
  // 与全站同一套渲染/交互模型，且回归里的 DOM 垫片能直接驱动它。
  dlg: null,
  busy: false,
  error: null,
  notice: null,
  // 「内核接入向导」与「登录页」等全站性状态都在下面各段自己声明。
  // 顶栏账号下拉（0.21.11）：与 `State.wb.accountMenu` **分开**两个字段 ——
  // 工作台不渲染顶栏、后台不渲染工作台，两者可能同时为 true 而不冲突；
  // 共用一个字段会让"在后台开着菜单切到工作台"看起来像菜单自己关掉了。
  topbarMenu: false,
};
