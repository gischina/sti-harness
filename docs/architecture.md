# 架构设计

> 本文是 `sti-harness` 的架构基线。所有实现必须与本文一致；如需偏离，先改本文再改代码。

---

## 1. 分层架构

单进程内部分层，**层间只允许自上而下依赖**，不允许反向：

```
┌──────────────────────────────────────────────────────────────┐
│  L5  前端（public/）                                          │
│      用户工作台 · 管理后台 · 自检页                            │
│      只调用本进程的 HTTP / WebSocket API，永不直连 DSH         │
└───────────────────────────┬──────────────────────────────────┘
                            │ 同源 HTTP + WebSocket
┌───────────────────────────▼──────────────────────────────────┐
│  L4  HTTP 层（app/http/）                                     │
│      路由表（单点定义） · 静态托管 · WS 双工桥                  │
│      中间件链：请求上下文 → 鉴权 → 租户解析 → RBAC →           │
│                配额 → 审计 → 限流                             │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  L3  业务层（app/platform/）★ 首期四项能力                     │
│      identity │ knowledge │ governance │ capability           │
│      + operation │ model │ schedule │ notify                   │
│      + observe/（指标，旁路观测，不参与放行判定）               │
│      只依赖 L2 契约层与 L1 数据层，不认识 DSH                    │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  L2  契约层（app/kernel/）★ 架构关键                           │
│      contract.mjs          AgentKernelContract（抽象定义）      │
│      dsh-provider/         DSH 实现（唯一允许碰 DSH 的目录）    │
│      unconfigured-provider.mjs  未接入时的占位（每个方法都给理由）│
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  L1  数据层（app/data/）                                      │
│      SQLite（node:sqlite，WAL） · 版本化迁移 · 仓储             │
│      文件存储（上传 / 产物 / 索引）                             │
└──────────────────────────────────────────────────────────────┘
                            │
                    ┌───────▼────────┐
                    │ DSH Runtime     │  ← 通过契约层访问，外面包着
                    │ （外部进程）     │     实时流、鉴权、事件映射、兼容垫片
                    └─────────────────┘
```

**为什么 L3 不能碰 DSH：** DSH 是快速迭代的上游（上游在 0.1.x 阶段就有过破坏性变更）。
把 DSH 依赖限制在 L2 的一个目录内，意味着升级 DSH 时改动范围可枚举——这是本项目从架构参考里学到的**最重要一条纪律**。

---

## 2. 请求链路

以「用户发一轮对话」为例，展示中间件链与职责边界：

```
1. 前端 POST /api/turns            （带会话 Cookie）
2. 请求上下文中间件   生成 requestId，绑定日志 span
3. 鉴权中间件         校验 HMAC 会话令牌 → 得到 userId；失败 401
4. 租户解析中间件     由 userId 解析 tenantId / 可访问组织；失败 403
5. RBAC 中间件        校验 (租户, 角色, 资源, 动作) → 拒绝则 403 且**记审计**
6. 配额中间件         检查该租户/用户的 token 配额与并发上限 → 超限 429
7. 审计中间件         开始一条审计记录（谁、何时、对什么、做什么）
8. 路由 → platform/ 业务层
9. 业务层调 kernel 契约 → dsh-provider → DSH Runtime
10. DSH 事件流 ← WS 双工桥 ← 前端
11. 事件映射后落库（events 表）+ 更新用量（usage_records，**带会话上登记的模型名**）
12. 审计中间件        收尾：结果、耗时、是否被治理拦截
13. 指标收尾          记 route/状态码/耗时（**无条件**，与第 12 步的口径相反）
14. 响应返回前端
```

**带附件的一轮**在第 8 步之前多一步：把请求里 `attachmentIds` 指向的附件取出来，按**内容**分流 ——
**图片**（按**魔数**识别）作为 `{type:'image'}` 内容块**真的送给模型**；**文本类**的正文被拼成引用块
追加到 `content` 后面（注入标记见 §7.7）；**其余二进制只登记**并在返回里点名。
因此轨迹里的 `turn-start.text` **等于真正发给内核的东西**（而不是等于用户在输入框里打的字）——
前端靠标记切分，气泡显示用户打的字，轨迹保留全文。

**审计要点**：第 7 步开启、第 12 步收尾，**治理拒绝也要留痕**（第 5、6 步的 403/429 同样写审计）。
这是「治理与审计是一等公民」这条取向的具体落地。

**用量归因要点**：第 11 步写 `usage_records.model_id` 时，取的是**会话行上登记的模型名**
（来自 `POST /api/kernel/sessions/:id/model` 或建会话时的显式选择），
**不是从上游事件里观测到的** —— 上游的 `usage` 事件不带模型名。
没登记过的会话写空串，其用量在成本报告里进 `unattributed` 桶，
**绝不拿"默认模型"的单价去套**（那会给出一个确定但错误的数）。见 §7.5。

**指标要点**：第 13 步与第 12 步是**两个独立函数**（`finalizeMetrics` / `finalizeAudit`），
因为两者口径相反 —— 审计只记**状态变更**（GET 成功不记），指标**每请求都记**（否则 rate 会系统性偏低）。
一个后果值得写出来：**本次请求不在它自己的指标响应体里**（统计发生在 handler 之后），
所以抓 `/metrics` 看到的是"上一次抓取为止"的状态。

---

## 3. 契约层设计（`app/kernel/contract.mjs`）

`AgentKernelContract` 定义产品层需要的**全部** Agent 能力。DSH 只是它的一个实现。

```js
/**
 * Agent 内核契约。所有方法返回 Promise；流式能力通过返回 AsyncIterable 暴露。
 * ⚠️ 这是产品层唯一能看到的内核接口。任何 DSH 专有的字段、错误码、
 *    事件形态都必须在 dsh-provider 内被翻译成本契约的形状。
 */
export const AgentKernelContract = {
  // ── 能力探测 ──────────────────────────────
  describe(),                  // → { kernel, kernelVersion, protocolVersion, skills, plugins, ready, source }

  // ── 会话 ──────────────────────────────────
  createSession({ cwd, presetId, title }),        // → { sessionId }
  listSessions({ cursor, limit }),                // → { items, nextCursor }
  renameSession({ sessionId, title }),            // → void
  forkSession({ sessionId, atSeq }),              // → { sessionId }
  cancelSession({ sessionId }),                   // → void
  disposeSession({ sessionId }),                  // → void

  // ── 回合（对话） ───────────────────────────
  submitTurn({ sessionId, requestId, content, attachments, mode }), // → { turnId }
  //   `attachments` 是**图片内容块**数组（`{type:'image', mediaType, data:base64, name?}`），
  //   与 `content` 一起组成上游的 `PromptContentPart[]` —— 这是"把图送给模型"的**唯一写入通道**。
  //   注：本平台**只有** dsh-provider 的 `toBlocks()` 碰它（原样透传），业务层不构造内容块。
  cancelTurn({ sessionId, turnId }),                                // → void
  streamTurns({ sessionId, fromSeq }),            // → AsyncIterable<KernelEvent>

  // ── 事件流 ────────────────────────────────
  subscribe({ kind, sessionId, ...}),             // → AsyncIterable<KernelEvent>
  snapshot({ kind, sessionId }),                  // → 开屏快照后自动取消（对齐上游快照接口的语义）

  // ── 模型 ──────────────────────────────────
  modelCatalog(),                                 // → { groups, default, routableProviders, failures }
  selectModel({ sessionId, provider, model, reasoningEffort }), // → void

  // ── 能力清单 ──────────────────────────────
  listSkills({ sessionId }),                      // → { roots, skills }   受治理过滤后的可见清单
  // ⚠️ 0.21.10：`listTools({ sessionId })` 已删除。工具不是内核对外暴露的**清单**，
  //    它由内核自己调用、以 `tool-call` / `tool-result` 事件的形式出现在事件流里
  //    （见 §7.11）。留一个"工具清单"方法会诱导调用方把事件流事实当成可登记资源。
  listMcpServers(),                               // → { servers }        受治理过滤后的可见清单
  listPlugins(),                                  // → { plugins }         上游插件目录（非工具）

  // ── 审批与治理 ────────────────────────────
  listPendingApprovals({ sessionId }),            // → { items }
  respondApproval({ sessionId, approvalId, decision, reason }), // → void
  requestQuestion / respondQuestion(...),         // 计划模式的确认入口

  // ── 产物 ──────────────────────────────────
  listArtifacts({ sessionId }),                   // → { items }
  readAttachment({ sessionId, attachmentId }),    // → { bytes, mime }（服务端代取，带会话凭据）
};
```

**统一事件形状**（`KernelEvent`）——所有 provider 必须归一到这一种：

```js
{
  seq, turnId, type,        // 'turn-start' | 'reasoning' | 'message' | 'tool-call'
                            // | 'tool-result' | 'approval' | 'usage' | 'error' | 'turn-end'
  role,                     // 'user' | 'assistant' | 'system' | 'tool'
  text, delta,              // 增量渲染用
  tool,                     // { name, args, result, status }
  usage,                    // { input, cacheRead, cacheWrite, output, reasoning }
  raw,                      // 原始上游事件（仅调试模式保留，默认不落库）
}
```

**两个实现**：

| 实现 | 用途 | 说明 |
|---|---|---|
| `dsh-provider/` | 生产 | 反代 + 鉴权 + 事件映射 + 兼容垫片 |
| `unconfigured-provider.mjs` | 未接入内核对外的**占位** | 每个契约方法都抛同一个带业务语义的错误码 `kernel_not_configured`，**绝不返回「看起来正常的空结果」**（那会让「没接入」与「接入了但没数据」混成一种状态）。0.21.4 起取代原来的 `mock-provider.mjs` —— 那个是「探测失败就**降级**到它」，而"真接上了"和"没接上但装作接上了"混成一种状态正是它最大的问题。测试用的替身移到 `tools/kernel-stub.mjs`，产品路径永远走不到它 |

**三条硬规则（保障上游升级影响面可控，见 `docs/feasibility.md` §6）**：

1. **事件语义归一**：落库 schema 用**自己的语义字段名**（`input_tokens` 等），
   上游字段名**只允许出现在 `events.mjs` 内**。禁止 `events` 表列名直接等于上游字段名
   ——否则上游改名会让字段**静默变空而不报错**。
2. **fixtures 回归**：真实上游事件流脱敏录制为 JSON fixtures，升级第一步跑它（M0 就建）。
3. **版本门禁**：`describe()` 返回真实版本；不在已验证矩阵内时**黄灯提示**，不静默放行。

**三道防线（0.15.0 起）—— 静态审计看不见运行期**

上游产品名不只是"源码里的字面量"。它还能藏进**运行期字符串**：provider 拼的散文、上游返回的
错误体、响应头 `Server` —— 这些从契约层一路显示到用户屏幕上，而 `tools/audit-layering.mjs`
（**源码静态扫描**）全程全绿。0.15.0 的真机验收就是这么漏的：在接入向导里填一个普通 Web 服务的
地址，页面显示「该地址有响应，但不像是 DSH（HTTP 200）」。所以补到三道：

| 防线 | 位置 | 挡什么 | 性质 |
|---|---|---|---|
| ① 静态审计 | `tools/audit-layering.mjs` | 源码里出现的上游专有名词，**含代码标识符**（如把状态名写成 `not-dsh`） | 主力 |
| ② 只报事实、话由产品层拼 | `dsh-provider/client.mjs` 只回 `facts`（`httpStatus` / `server` / `contentType`）；结论文案在 `connection-config.mjs` 的 `KERNEL_STATE_TEXT` | "结论里夹带品牌"这类**设计层**泄漏（provider 不该有自己的措辞） | 主力 |
| ③ 运行期抹名 | `dsh-provider/brand.mjs` 的 `neutralizeUpstreamText()` + 契约层 `sanitizeStatus()` | 我们**控制不了**的文本（上游错误体、响应头） | 幂等兜底 |

第 ③ 道是**兜底不是主力** —— 能不说就不说（②），实在绕不过才改字（③）。
另有 **HTTP 级运行期扫描**回归钉住它不被绕过：`test-http` 里"代表性接口的响应体里不得出现上游产品名"
（运维接口名如 `dshOrigin` 属接口契约、改名代价更大，走**带根据的白名单**，只到标识符、不含散文）。

> 这条教训比这个缺陷本身重要：**"回归全绿"只覆盖它扫得到的形态**。
> 一份只在源码里找字符串的审计，等于在说"源码里没有"，而不是"用户看不到"。

---

## 4. DSH provider 隔离规则

`app/kernel/dsh-provider/` 是**唯一**允许出现 DSH 专有名词的目录（`session/follow`、`cordis.patch.yml`、`dsh web` 等）。

```
app/kernel/
├─ contract.mjs      # 契约形状（本目录唯一不属任何实现的文件）
├─ index.mjs         # 契约层实现：选内核（配置里有地址就用、没有就是"未接入"）、把 provider 的原始状态 sanitize 后对外（§3 第 ③ 道防线）
├─ connection-config.mjs  # 接入向导的纯逻辑：地址/令牌归一、配置合并、诊断词表 KERNEL_STATE_TEXT、待重启对账
├─ unconfigured-provider.mjs # 未接入时的占位 provider（所有方法抛 kernel_not_configured）
└─ dsh-provider/
   ├─ client.mjs       # 地址与令牌解析、token→cookie 换取、反代、重换会话；**只回 facts，不写散文**
   ├─ transport.mjs    # HTTP 与 WebSocket 双工桥（自研：node:http upgrade + 帧掩码，无第三方 ws）
   ├─ events.mjs       # 上游事件 → KernelEvent 的映射（含 reasoning-delta、usage 抽取）
   ├─ capability.mjs   # 插件树 / MCP 握手 / Skills 根目录探测
   ├─ brand.mjs        # 上游产品名的**唯一集中处** + 运行期抹名 neutralizeUpstreamText（§3 第 ③ 道防线）
   └─ compat/          # 按上游子系统的兼容垫片，一个版本一个文件
      └─ 0.1.5-rc.2.mjs
```

> **`brand.mjs` 为什么单独成文件**：`client.mjs`（生产错误路径）与契约层 `index.mjs`（`sanitizeStatus`）
> 都要用它 —— 塞进任一方都会造成循环依赖。

**硬规则：**

1. 不 fork、不 vendored、不 patch DSH 源码。
2. 产品层与前端代码里出现 DSH 专有名词 → 视为架构违规，由回归脚本（`tools/audit-layering.mjs`）拦截。
   ⚠️ 这条只覆盖**源码**，运行期字符串另由 §3 的第 ②/③ 道防线处理。
3. 兼容垫片按上游版本命名，纯函数优先，便于将来删掉旧版本。
4. 契约层的 `describe()` 必须返回真实探测结果（版本、Skill 数、插件数、来源），**探测失败要如实上报，不允许假装可用**（诚实数据源原则）。⚠️ 0.21.10 起 `describe()` **不再有 `tools` 字段**（工具不是可探测的清单，见 §7.11）。
5. **provider 不产出面向用户的结论句。** 它只回事实（HTTP 状态、响应头、内容类型、原始体），
   "这意味着什么 / 下一步做什么"由产品层的 `KERNEL_STATE_TEXT` 说 —— 否则每加一个失败分支，
   就要在豁免区里再写一句可能带上游品牌的话。

---

## 5. 模块职责

### L4 HTTP 层

| 模块 | 职责 |
|---|---|
| `router.mjs` | **路由唯一真源**。表里每条含 `id / method / path / capability / scope`；中间件链由 `scope` 推导，不在各 handler 里重复写鉴权 |
| `static.mjs` | 静态托管 `public/`；用户误用 `file://` 直接打开 `index.html` 时，给出明确指引而不是白屏 |
| `ws-bridge.mjs` | DSH 实时流双工桥：两侧握手校验后做**透明字节管道**，不解帧、不重新编码 |
| `middleware/` | `context` / `auth` / `tenant` / `rbac` / `quota` / `audit` / `ratelimit` |
| `observe/metrics.mjs` | 进程级指标登记与 Prometheus 文本渲染（P1-2）。**不是中间件** —— 它被中间件链的收尾钩子调用，但本身不参与放行判定 |

> **`observe/metrics.mjs` 刻意不塞进 `middleware/`**：中间件链是**请求门禁**（能拒绝请求），
> 指标是**旁路观测**（只读不改行为）。把观测塞进门禁链，下一次改门禁的人就有机会把指标一起改坏。
> 这也解释了为什么它的收尾调用是**另一个**函数（`finalizeMetrics`）而不是并进 `finalizeAudit`：
> 两者口径相反 —— 审计只记**状态变更**（GET 成功不记，靠"少记"维持信噪比），
> 指标**每请求都记**（靠"一个不漏"算 rate）。

### L3 业务层（首期四项 + `operation` + `model` + `schedule` + `notify`）

| 模块 | 核心表 | 关键能力 |
|---|---|---|
| `identity/` | `orgs` `departments` `users` `roles` `groups` `group_members` `role_bindings` `auth_sessions` `api_keys` `credentials` `user_totp` `user_recovery_codes` `login_challenges`（0019） | 登录、scrypt 口令、HMAC 会话令牌、RBAC 判定（含**组级绑定**）、凭据 AES-GCM 加密、**两步验证（TOTP，0019）**（口令通过后发**短时票据**，第二步交动态码或一次性恢复码换正式令牌；恢复码哈希落库、步号 CAS 防重放；**未开启者登录路径逐字不变**）、**CSV 批量导入用户**。⚠️ **SSO/LDAP 未实装**（无预留表结构、无适配器代码 —— 接它属新增，不是接线；边界属主见 `deploy.md` §10） |
| `knowledge/` | `knowledge_bases` `documents` `chunks` `chunk_fts`(FTS5) `chunk_vectors` | 解析、分块、向量化、**FTS5 + 向量混合检索**、引用溯源、库级隔离、重试/重新向量化与向量来源可追溯 |
| `governance/` | `audit_logs` `quotas` `usage_records` `audit_chain_state` `audit_anchors` | 审计留痕（哈希链 + 归档 + 链尾锚定）、配额与用量（含**并发瞬时闸**）、**成本核算（token → 金额）**、执行追溯、产物留存 |
| `capability/` | `skills` `mcp_servers` `capability_bindings` | 清单、安装/启停、版本更新、可见性治理、导入导出 |
| `operation/` | `—`（直接操作 `data/` 与备份文件） | `VACUUM INTO` 在线快照 + SHA256 manifest、备份列举/校验。与上面四个**同构**：`service.mjs` 门面 + 路由只做「解析 → 调服务 → 响应」 |
| `model/` | `model_providers`（0008） | **多 provider 配置 + 连通性探活 + 默认模型/降级链 + 知识层接缝**。**不做请求转发**（那不是配置中心，是 gateway） |
| `schedule/` | `scheduled_jobs`（0009） | 按时间自动执行任务：规则解析（只认 `interval:<毫秒>` 与 `dailyAt:HH:MM`）、下次执行计算、重入保护、执行体白名单、结果记账 |
| `notify/` | `notify_channels` `notify_deliveries`（0009 / **0016**） | 出站通知：事件白名单、URL 加密落库、SSRF 目标校验、投递与记账、**失败重投队列**（指数退避、上限转 `dead` 但保留可见可手动重投）到 `notify_deliveries`（0016） |

> `model`（模型中心）是 P1-1 新增的第六个平台模块。它刻意只做「配置 + 探活 + 排序」，
> 不做请求转发 —— 把配额从事后统计升级为事前拦截需要 gateway 本体（必须挂在模型调用路径上），
> 那是另一件事。它给知识层提供 `resolveEmbeddingForIdentity(tenantId)` 接缝，
> 使「页面上配的向量模型」与「检索真正调用的模型」是同一份（详见 `roadmap.md` P1-1）。

> `schedule` 与 `notify` 是 P1-2 新增的第七、八个模块，两者是**一对**：
> `schedule` 决定"什么时候该检查"，`notify` 决定"查出问题后怎么告诉人"。
> 缺前者，所有周期性动作靠人记得；缺后者，治理结论只能等人主动打开页面看。
>
> `schedule/` 刻意**不实现 cron 解析器**：一套 cron + 时区 + DST 是独立的复杂度来源，
> 而 90% 的诉求 `interval` 与 `dailyAt` 两种规则就够。规则在**写入时**即校验 ——
> 落库一个解析不了的规则，之后每一轮扫描都会静默跳过它，那是最坏的形态。
> 同样刻意**不补跑错过的任务**：进程停了就没有调度。理由是"补跑一次归档"与"补跑一次备份"
> 的风险完全不同，让调度器统一猜是错的。这些边界写在页面与 `status.boundaries` 里。
>
> `notify/` 的投递：单次**最多 2 次尝试**（指数退避），仍然失败则**落 `notify_deliveries` 队列**（0.11.1 起，迁移 0016），
> 由 `notify.retry` 定时任务按指数退避重投（最多 6 次，超限转 `dead` 但**保留可见、可手动重投**）。
> **语义是 at-least-once**：同一条投递的首次尝试与所有重投共用 `X-STI-Delivery-Id`，去重交给接收方。
> ⚠️ **仍然成立的边界**：队列是**本机单进程**重投（与调度器同一约束：无分布式锁），
> 平台**整体停机期间**的告警照样会丢 —— 变的只是"上游抖动不再等于告警丢失"。

> `governance/cost.mjs`（P1-3）把「用了多少 token」升级成「大概花了多少钱」。
> 它刻意**单独成一个模块、单独一条路由**，不与 `usage` 合并：两者口径不同 ——
> usage 是事件照抄的客观 token 数（可逐字段核对），cost 是 `token × 当前单价` 的估算（依赖配置、会随时间变）。
> 混在一个响应里，前端就分不清哪个数能拿去对账。它不认识 `model` 模块，
> 模型条目由装配层注入（`resolveProviders`）—— 与其他纵向能力的接缝方式一致。
> 详细口径见 §7.5。

> `app/data/repositories/attachments.mjs`（P1-3 / 3.6）是**数据层**的一个仓储，不是平台模块 ——
> 与 `sessions.mjs` / `events.mjs` 同级，由 kernel 路由直接使用。它只管元数据
> （每一条 SQL 都带 `tenant_id` **且带 `session_id`**），**不碰 fs、不认 `paths.mjs`**：
> "存到哪、叫什么名"是运行时信息，属于路由层。这条分层有回归钉住
> （`test-core`：仓储源码里不得出现 `node:fs` / `STORAGE_DIR`）。

> `operation` 曾是五个模块里**唯一没有 `service.mjs` 门面**的一个，业务逻辑（目录列举、文件名合法性校验）
> 长在路由层。现已收敛为 `createOperationService({ dataDir })`；`resolveBackup` 是**唯一路径校验点**
> （拒绝 `/`、`\`、`..`），并刻意**不暴露 `restoreBackup`**（不存在的入口比"请勿调用"的入口安全）。

---

## 6. 数据模型

单文件 SQLite（`data/sti-harness.db`），WAL 模式，版本化迁移（`app/data/migrations/NNNN_*.sql`）。

### 6.1 身份与权限

```sql
orgs            (id, name, slug, parent_id, created_at)
departments     (id, org_id, name, parent_id)
users           (id, org_id, dept_id, username, display_name, pwd_hash, pwd_salt,
                 status, is_admin, created_at, last_login_at)
roles           (id, org_id, key, name, description, is_builtin)
groups          (id, org_id, name, description, created_at)                       -- 0007
group_members   (id, group_id, user_id, created_at)                               -- 0007
role_bindings   (id, subject_type, subject_id, role_id, scope_type, scope_id)  -- subject: user|group
                -- subject_type='group' 时 subject_id 指向 groups.id；
                -- 一组人的生效角色 = 直接绑定 ∪ 所属组绑定（见 §7.2）
auth_sessions   (id, user_id, token_hash, expires_at, ip, ua, created_at, revoked_at)
api_keys        (id, user_id, name, key_hash, scopes, expires_at, last_used_at)
credentials     (id, org_id, name, cipher, iv, tag, ref_count, updated_at)   -- AES-256-GCM
user_totp       (user_id PK REFERENCES users(id), secret_enc, enabled_at,   -- 0019
                 last_used_step, created_at, updated_at)
                -- 密钥 AES-256-GCM 信封；enabled_at IS NULL = 已登记未确认；
                -- last_used_step 严格递增 —— 同一窗口的码不可重放（RFC 6238）
user_recovery_codes (id, user_id REFERENCES users(id), code_hash, used_at,  -- 0019
                 created_at)
                -- 一次性恢复码，HMAC-SHA256（带主密钥）哈希落库；重生成整批替换
login_challenges (id, user_id REFERENCES users(id), org_id, ticket_hash,    -- 0019
                 attempts, expires_at, consumed_at, ip, ua, created_at)
                -- 两步登录的"第二步票据"：单次消费 + 尝试计数 + 过期都是跨请求状态，故落库；
                -- ticket 只存 HMAC；不建外键到 orgs（与 login_lockout 同），
                -- user_id 外键由 deleteUser 显式清理
```

> **为什么 0007 才补 `groups`**：`role_bindings.subject_type` 从一开始就写着 `user | group`，
> 但 `groups` 表到 0007 才存在 —— 期间这是一处**静默空转**（写进库、判权时读不到、还不报错）。
> 现在两者成对存在；`groups` / `group_members` 沿用身份模块的 `org_id` 命名（不是 `tenant_id`），
> 因此**不在 `audit-tenant-isolation` 的静态扫描范围内**，其跨租户隔离由动态用例兜底。

### 6.2 会话与事件

```sql
agent_sessions  (id, tenant_id, owner_user_id, kernel, kernel_session_id,
                 title, cwd, preset_id, model_provider, model_id, kb_ids,
                 created_at, updated_at, archived_at)
                -- kb_ids（0017，0.14.0）：本会话挂载的知识库 id，存 **JSON 数组字符串**（默认 '[]'）。
                --   **刻意不建外键、不建关联表**：挂载是一份**声明**（"这个人挂了这个库"），
                --   而"这一轮到底注入了什么"是**效果** —— 两者必须分开（后者由 `knowledge` 帧呈现）。
                --   库随时可能被删或被收紧为 `restricted`，那时应当**检索时按 ACL 如实丢弃**，
                --   而不是让删除被外键挡住、或留下一行悬空关联、或让一句谎言留在会话里。
messages        (id, session_id, turn_id, seq, role, content_json, created_at)
events          (id, session_id, turn_id, seq, type, payload_json, created_at)
                -- 索引 (session_id, seq)；这是轨迹/交付物/工作流/统计的唯一数据源
usage_records   (id, tenant_id, user_id, session_id, turn_id,
                 input, cache_read, cache_write, output, reasoning,
                 ttft_ms, tps, model_id, created_at)
session_attachments (id, tenant_id, session_id, user_id, name, mime,
                 bytes, kind, stored_path, sha256, created_at)      -- 0012（P1-3 / 3.6）
                -- 索引 (tenant_id, session_id, created_at)。
                -- 为什么单独一张表、而不是塞进 events 的 payload：
                --   ① 附件是**对象**（名字/大小/哈希/路径），不是一次性的语义事件；
                --      塞进 payload 就只能靠"从事件流里捞最后一条"来查，改一次名字要改历史；
                --   ② 删除附件必须能**真的删到字节上**（合规的"删除请求"），
                --      而事件是 append-only 的轨迹 —— 两者生命周期根本不同，不该同表。
                -- `stored_path` 存**相对 STORAGE_DIR** 的路径：绝对路径会把部署机的目录结构
                -- 泄漏到 API 响应里（换机器就全成死链）。`hydrate()` 根本不输出这个字段。
                -- `kind` 只有 `text` / `binary`，判据是**内容**（有 NUL 字节或非法 UTF-8 序列
                -- 即为 binary），**不看扩展名** —— 文本决定"能不能注入本轮上下文"；
                -- `mime` 存的是**内容嗅探**结果（图片按**魔数**判定，见 §7.7），不采信浏览器声明。
                -- `tenant_id` 是冗余的（可经 session_id 推出），但必须存：附件是**按 id 直接寻址**
                -- 的资源，每一次读写都要能一句话证明"它属于这个租户"，不允许依赖间接推理。
```

### 6.3 知识库（混合检索）

```sql
knowledge_bases (id, tenant_id, name, embedding_provider, embedding_model, dim, created_at)
documents       (id, kb_id, title, mime, size, sha256, storage_path,
                 status, error, chunk_count, created_at, parsed_at)
chunks          (id, doc_id, kb_id, ord, text, bigrams, meta_json, token_count)
chunk_fts       -- FTS5 虚拟表：(text, bigrams, content='chunks', content_rowid='id')
chunk_vectors   (chunk_id, dim, vec BLOB)   -- Float32Array 直接落 BLOB
```

> ⚠️ **中文分词：绝不使用 unicode61 裸索引（实测证伪）。**
> 实测结论（SQLite 3.50.4）：unicode61 把一整段连续汉字当作**一个 token**，
> 「企业级智能体生产平台的权限管理」用 `MATCH '权限管理'` / `MATCH '权限'` **均为 0 命中**，
> 只有整句或前缀才命中。trigram（3.34+ 内置）对 ≥3 字可用，但**2 字词（「权限」「管理」「平台」）
> 召回为 0**，中文场景不可接受。**唯一可行方案是 bigram 预处理**：
> 写入时把文本切成重叠双字串（`企业级…` → `企业 业级 级智 …`）存入 `bigrams` 列，
> 查询侧做同样切分后按短语匹配；短语 0 命中时退化为 bigram `AND` 组合（容忍换序）；
> 单字查询退化 `LIKE` 前缀。详细实测数据与取舍见 `docs/feasibility.md` §1.2.1。

**混合检索算法**（单机、零依赖）：

1. **召回**：FTS5 `bm25()` 取 Top-K₁（中文经 bigram 预处理）；向量侧对候选集做**暴力余弦**取 Top-K₂（见 §8 规模边界）。
2. **融合**：RRF（Reciprocal Rank Fusion）合并两路排名，避免量纲不一致。
3. **重排**（可选）：若配置了 rerank 模型则调用，否则跳过——**不假装做过重排**。
4. **截断**：按预算取 Top-N，附带 `chunk_id → doc_id → 页码/位置` 的引用链。

### 6.4 治理与能力

```sql
audit_logs      (id, tenant_id, user_id, action, resource_type, resource_id,
                 result, detail_json, prev_hash, hash, at)
                -- prev_hash/hash 形成哈希链，防篡改（见 §7.3）
approvals       (id, tenant_id, session_id, turn_id, tool_name, args_json,
                 status, decided_by, decided_at, reason, created_at)
                -- 0.16.2 起停用：平台侧工具执行功能族（工具网关/工具策略/审批队列）
                -- 已整体拆除（上游 wire 契约不提供平台侧工具执行）；
                -- 表仅因迁移不可改写而保留，不再有任何读写方
quotas          (id, tenant_id, subject_type, subject_id, metric,
                 limit_value, period, enabled)
skills          (id, tenant_id, name, source, version, path, enabled,
                 model_invocable, installed_at, meta_json)
tools           -- 0.21.10 已删除（DROP TABLE，迁移 0025）
                -- 这里曾是一张工具登记表：tools(id, tenant_id, name, origin, enabled,
                -- policy_json, meta_json)，随 GET /api/capability/skills 的 registryTools 下发，
                -- 用来做"实际调用 ↔ 清单"的对账。用户裁定「工具来自会话事件流投影，
                -- 去掉关于工具的所有内容」——工具由**内核自己调用**，不像 Skill 那样是一个
                -- 可以单独登记/启停/治理的能力，也不存在"有哪些工具"这份清单。
                -- 它仍然以**事件流事实**的形式存在：events 表里的 tool-call / tool-result
                -- （见 §7.11），工作台的工具卡照旧逐条渲染。删的只是"登记与对账"。
mcp_servers     (id, tenant_id, name, transport, config_cipher, enabled, health)
capability_bindings (id, tenant_id, subject_type, subject_id,
                     capability_type, capability_id, allow)   -- 二级治理：连接/服务
                -- ⚠️ 0.21.10：`capability_type` 的值域去掉 `tool`（BINDING_LEVELS 同步收窄），
                -- 迁移 0025 已 DELETE 掉历史 tool 行。因为没有任何判定再读它，
                -- 留着只会成为一行"永远不生效"的死数据 —— 写进去也不报错，读起来像配好了。
model_providers (id, tenant_id, name, kind, protocol, base_url, model,
                 credential_name, priority, enabled, is_default,
                 label, meta_json, created_at, updated_at,
                 currency, price_in_minor, price_cache_read_minor,
                 price_cache_write_minor, price_out_minor)           -- 0008 / 0011 加单价
                -- 默认唯一性由**部分唯一索引**保证：
                --   CREATE UNIQUE INDEX ... ON model_providers(tenant_id, kind)
                --   WHERE is_default = 1
                -- 服务层漏清旧默认会被库层直接拒绝，而不是留下两个默认让结果取决于行序。
                -- credential_name 存的是凭据**名**，值在 credentials 表 AES-256-GCM 加密；
                -- 公开形状只出名称与 hasCredential，没有承载值的字段。
                -- 五个单价列**可为 NULL**，含义是"没配这个价"，**不是 0 元**（0 是"免费"）。
                -- 不加 CHECK：node:sqlite 的 ALTER TABLE 支持有限，且负价/坏币种在服务层已拦住 ——
                -- 把校验只放在库里，错误信息会退化成一句运维读不懂的 SQL 报错。口径见 §7.5。
scheduled_jobs  (id, tenant_id, name, kind, schedule, params_json, enabled,
                 last_run_at, last_status, last_detail_json, next_run_at,
                 run_count, fail_count, created_at, updated_at)      -- 0009
                -- UNIQUE(tenant_id, name)；idx(tenant_id, enabled, next_run_at) 是到期扫描的索引。
                -- 到期判定：enabled=1 AND next_run_at <= now —— `next_run_at IS NULL` 的启用任务
                -- **不跑**，只在下一次扫描补算。NULL 意味着"我们不知道该什么时候跑"（例如库被手改），
                -- 直接跑一个规则不明的任务比不跑更危险。
notify_channels (id, tenant_id, name, kind, url_cipher, credential_name,
                 events_json, enabled, last_delivery_at, last_status,
                 fail_count, created_at, updated_at)                -- 0009
                -- UNIQUE(tenant_id, name)。url_cipher 是 AES-256-GCM 密文：
                -- 出站 URL 常内嵌机器人 token（`?access_token=`），它**等价于一个密钥**。
                -- 因此公开形状只给 host，不给完整 URL，连 query 都不给。
audit_anchors   (id, tenant_id, day, tail_hash, record_count,
                 file_path, anchored_at)                            -- 0009
                -- UNIQUE(tenant_id, day)。链尾锚点的落表副本（便于页面展示）。
                -- ⚠️ 它**本身防不住**"有库权限的人连锚点一起改"——锚点只有离开本机才有意义，
                -- 因此可选通过 notify 事件 `audit.anchor` 出站。
audit_chain_state (tenant_id PRIMARY KEY, base_hash, archived_count,
                   archived_at, updated_at)                         -- 0009
                -- **审计归档不破坏可校验性的关键**，见 §7.3。
```

> **`model_providers` 的 `tenant_id`（对比 `groups` 的 `org_id`）**：本表用 `tenant_id`，
> 因此被 `audit-tenant-isolation` 静态扫描覆盖（0008 时 13 张，0009 后 17 张，0012 后 **18 张**）。降级链不另建链表 ——
> **同 `kind` 内按 `priority` 升序的启用项序列**即是链，顺序在 `priority` 一列里已完整。

> **`audit_chain_state` 只有一行、没有 `id`**，这不是疏漏：它是"每个租户一条"的**单例状态**，
> 用 `tenant_id` 直接做主键最贴切。它同样进隔离扫描表清单（SQL 里带 `tenant_id`）。
> 三条 0009 主表（`scheduled_jobs` / `notify_channels` / `audit_anchors`）也全带 `tenant_id`。
> **投递明细刻意不另建表**，而是走审计链 —— 两套"投递记录"意味着两个真相，
> 迟早会出现"页面上显示发了、链里查不到"这种没人能判定谁对的分歧。

---

## 7. 关键机制

### 7.1 鉴权（零依赖）

- 口令：`crypto.scryptSync(pwd, salt, 64)`，`salt` 每用户随机 16 字节，比较用 `crypto.timingSafeEqual`。
- 会话令牌：`base64url(payload) + '.' + HMAC-SHA256(payload, serverSecret)`，`payload` 含 `sid / uid / exp`。
  服务端只存 `token_hash`（SHA-256），**不存明文令牌**。
- 凭据加密：AES-256-GCM，密钥来自 `data/.secret`（首次启动生成，权限 0600）。
  密文格式 `iv‖tag‖cipher`，`credentials` 表**只存密文**，任何接口不回显明文。
- 两步验证（TOTP，0019）：口令通过后**不发令牌、发短时票据**（`login_challenges` —— 单次消费 +
  尝试计数 + 过期，三者都是跨请求状态故落库；票据只存 HMAC）。第二步交动态码或一次性恢复码，
  验过才换正式令牌；步号严格递增（CAS 写 `last_used_step`，同一窗口的码不可重放），
  恢复码每张只能用一次。**未开启者的登录路径逐字不变**。
- 首次启动无用户时 → 强制进入初始化向导（不需要容器）。

> ⚠️ **安全模型分叉（相对单机工具）**：单机工具习惯只绑 `127.0.0.1`，因为它是单人本机工具。
> 本平台**必须多用户**，因此必须补齐：**HTTPS（或置于反代后）**、Cookie `Secure`+`HttpOnly`+`SameSite`、
> **CSRF token**（写操作）、**登录限流 + 全局限流**、**会话空闲超时**、密码强度校验。
> 缺失任意一项都会把含凭据代理与文件下载的服务变成事故面。详见 `docs/feasibility.md` §7.2。

### 7.2 RBAC

四元组判定：`(tenantId, roleKeys, resourceType+resourceId, action)`。

- 内置角色：`owner` / `admin` / `member` / `viewer`（可扩展）。
- **生效角色 = 直接绑定 ∪ 所属组绑定**：`roleKeysForUser()` 把 `subject_type='user'` 与
  `subject_type='group'`（经 `group_members` 展开）两路并起来去重。认证路径
  （`authenticate` / `login` / `publicUser`）每次请求都带出组带来的角色 —— 少了这一步，RBAC 层就看不见组。
- 「谁是管理员」以**生效角色**为准：`users.is_admin` 只是物化列，真源是 `role_bindings`；
  组让这件事变成**间接**（用户 ← 组 ← 角色），因此读物化列会多出一份可能漂移的真相。
- 「不许把最后一个 owner 弄没」的保护按**生效**算，且**穿透组**（`countHolders` 数生效用户去重，
  `countActiveHolders` 只数 `status='active'` —— 停用不改绑定，只"数绑定"看不出问题）。
- 权限声明集中在 `identity/permissions.mjs` 一张表，**逐条可读**（不用位运算魔法）。
- 判定函数是纯函数 → 可直接被 `node:test` 单元测试覆盖。
- 路由表的 `capability` 字段声明所需权限，中间件统一执行，**handler 内不写鉴权**。
- ⚠️ **判定口径可以细于租户级 —— 这时判定点必须下移到服务层。** 4.6 的库级 ACL 是第一个例子：
  "某人在**这个库**上被授了什么"只有服务层知道（`role_bindings.scope_type='knowledge_base'`），
  所以知识库的写路径路由门只声明 `knowledge:read`，真正的档位判定在 service 里做。
  若沿用 `knowledge:write` 声明，**库级管理员会被路由层直接挡死，4.6 等于没做**。
  代价是"判定点后移"，靠回归兜住：写路径的每条拒绝行为都有用例，并有一条**反向断言**
  钉住路由的能力声明（防"顺手修回去"）。
- ⚠️ **推论：客户端不得用更粗的口径替服务端下结论。** 前端的 `allowed()` 只读得到**租户级**角色，
  因此凡判定口径细于租户级的入口（库级授权面板，0.12.0），只能"**照样渲染 + 照实呈现服务端结论**"
  （`403` = 看得见但档位不够 / `404` = 对你不可见，两者**分开、不含混**），不能在客户端预隐藏 ——
  否则就是拿租户级口径覆盖库级口径。详见 §10 第 12 条。

### 7.3 审计（防篡改哈希链）

每条审计记录写入时计算：

```
hash = SHA256(prev_hash ‖ tenant_id ‖ user_id ‖ action ‖ resource ‖ result ‖ detail ‖ at)
```

`prev_hash` 取自同租户上一条。校验接口可从头重算整条链，一旦中间被删改即断裂。
**治理拒绝（403/429）也必须写审计**，且 `result` 标记为 `denied`。

**归档会破坏朴素实现的链（这是 0009 修掉的一个正确性缺陷）。**
链按行记 `prev_hash`，而校验从 `prev = ''` 起算。一旦按保留期删掉最旧的若干行，
剩余第一条的 `prev_hash` 指向**已删除**的行，校验会在第 0 行**误报断裂** ——
报出来的"首个断裂点"是假的，最坏的结果是让人不再信这条链。

因此引入**链基准** `audit_chain_state.base_hash`：

- `write`：`prev_hash` 取同租户最后一条的 `hash`；**没有行时取 `base_hash`**（而非 `''`）。
- `verify`：从 `base_hash` 起算，并**在返回值里回报 `base`** —— 只报"通过了"是不够的，
  调用方需要知道这次校验覆盖的是哪一段。
- `archive`：**先落盘、后删除**。归档文件写失败则**一条都不删**（"删了但没存下"是不可逆的数据丢失）；
  删除与 `base_hash` 更新在**同一事务**里完成；并且**归档动作本身入链**（否则"谁清了哪些行"没有痕迹）。
  归档文件按 `audit-<tenant>-YYYYMM.jsonl` 分月追加。

> **链尾锚点只有离开本机才有意义。** `anchor()` 把当日最后一条的 `hash` 与记录数落到
> `data/anchor/*.json` 与 `audit_anchors`，用于发现"整表重写"。但它防不住"有库权限的人
> 连锚点一起改"，所以锚点必须可选地通过 `notify` 事件 `audit.anchor` **出站** ——
> 离开这台机器，才第一次具备了独立的证明力。
> 锚点同时报 `tailHash` 与 `baseHash`：**只给链尾等于只给一半信息**，
> 无法判断链是否被从头部截断。

> **保留期不是"可以随便调小"的参数。** `retentionDays` 删的是审计记录本身；
> 调小它等于主动降低可追溯窗口。默认 90 天，且归档出来的 `.jsonl` 必须与数据库一起备份
> （否则"归档"变成了"删除"，只是换了个说法）。

### 7.4 配额与用量

- 用量来源：契约层 `usage` 事件（真实 token 数），不估算。
- 配额按 `(subject, metric, period)` 维度，在中间件里**先检后放行**。
- 超限行为可配：`block`（拒绝）或 `warn`（放行但告警并记审计）。
- `concurrent`（并发在途回合数）是**瞬时量**，没有周期累计语义：`consumed` 返回
  `{used, instantaneous: true}`，`since` 为 `null`。

**取数规则只有一份实现：`app/util/usage-pick.mjs`（0.15.0 起）。**

规则三条：① 任何带 `usage` 对象的记录都算 —— **上游没有独立的 `usage` 事件**，用量挂在
`assistant/message` 上（`dsh-provider/events.mjs` 顶部早已写明这点）；② 同一轮里**有独立 `type='usage'`
事件时只认它**（否则同一笔账会被记两遍）；③ 缺数字就是缺，不补 0。

> **为什么必须合成单一真源**：记账（`governance/usage.mjs` 的 `recordFromEvents`）与汇总
> （`repositories/events.mjs` 的 `usageSummary`）原本是**两份实现**，且**都只认 `type='usage'`**。
> 真机上一轮真实对话就这样：`usage_records` 记 0 行、工作台显示"累计 tokens 0" ——
> 而 DB 里明明躺着 `{"input":562,"cacheRead":6656,"output":2}`。
> 0 不是"没数据"，是一句**与事实相反的话**。
>
> 同一个量有两份实现，迟早会算出两个数；而这类缺陷最阴的地方是**回归全绿** ——
> `test-external` 那句注释「用量可能为 0（上游未回报 usage 时）」是**假前提**，
> 它把一个真缺陷写成了预期行为。已改成"**有观测就必须有账**"的交叉核对
> （先取 events 里的 usage 观测，再对 `usage_records` 求和；无观测须为 0，有观测须 > 0）。

> **并发闸的判定与计数必须原子。** 不能"先 `evaluate` 再 `enter`" —— 两步之间有窗口，
> 两个同时到达的请求可以双双通过判定、双双入场，闸门等于不存在。
> `enterConcurrent()` 把**判定 + 自增收在一个同步函数**里。
> `enter` / `leave` 必须成对（调用方用 `finally`），泄漏的表现形式是"没人用却报并发超限"。
>
> **闸门放在路由层（回合提交的唯一入口），且流式路由必须在开流之前判**：
> 开流后状态码已经锁死 200，拿不到 429 了。

> **为什么 `concurrent` 在 M3 留作未实装、在 P1-2 才做**：M3 时还留着"横向扩展"的可能，
> 那时内存计数只是**临时方案**（多实例下每个进程各数各的，必然出错）。
> 到 P1-2，「单进程」已经成为**架构承诺**（§10.1），于是内存计数从"临时方案"变成了**正确答案** ——
> 这不是"终于挤时间做了"，而是前置条件变了。

### 7.5 成本核算（`governance/cost.mjs`，P1-3）

`usage_records` 里已经有逐字段照抄的真实 token 数，但"花了多少钱"在 0.8.0 之前没有任何出口。
企业内控口径上，「本月用了 3200 万 token」不如「本月花了 480 元」能对上财务。
这一节把口径写死，因为**金额这条最容易做成"看起来对"的东西**：算错的金额和算对的金额长得一模一样。

单价存在 `model_providers` 上（迁移 `0011`），单位是**最小货币单位 / 每 100 万 token**（分/美分 ÷ Mtok）。
不另建价格表：单价是**条目属性**，与降级链同源 —— 链按 `priority` 选中的那条就是实际计费的那条；
另建一张表就要维护"价格与条目一致"，而那种一致性迟早会漂。

**三条不允许违反的规则**（每一条都对应一种"会让金额算错"的输入）：

| 规则 | 违反后的表现 |
|---|---|
| **没配单价 = "不知道"，不是 0 元**（`amountMinor` 为 `null`） | 0 会被读成"免费调用"，算出一个偏低的、看起来完全正常的总额 |
| **缓存价不许用输入价顶替**（`cache_read` 没配价 → 那部分 token 记"未定价"） | 缓存读常是输入价的 1/10、缓存写常更贵。顶替产生的偏离方向取决于用量结构，外人无从判断对错 |
| **单价不追溯，也不快照**（金额每次按**当前**单价重算） | 口径必须写成"按当前单价估算"。反过来说：**改价会让历史用量的金额一起变**，要留证得先导出 |

配套的两条：

- **归因靠 `usage_records.model_id` 匹配 `model_providers.model`**（就是"模型名"这一列）。
  匹配不到 → 进 `unattributed` 桶，**不拿默认模型的价去套**。
  同模型名有多条登记时，按 `(priority, id)` 取第一条 —— 与降级链的选法一致，且结果确定。
- **不同币种分开合计**。把 CNY 与 USD 加在一起是个无意义的数，所以 `totalsByCurrency` 是**一组**合计，
  并给出 `mixedCurrency` 标记；页面上也不做一个"总额"卡片。

金额全程**整数运算**（`Σ(token × 单价)`，最后一步才 ÷ 1 000 000 并四舍五入）：
用浮点存金额迟早会漂出 0.01 级的误差，而那种误差没有任何人能一眼看出来。
`reasoning` 是 `output` 的子集，**不另计** —— 另计就是重复收费。

> **诚实边界**：这是**估算**不是账单。真实计费以供应商结算为准；本平台不转发请求（不是 gateway），
> 因此也无法在模型调用路径上做精确的实时计费。
> 另外，`no_source_file` 式的"归因不到"在本能力里是**常态**而非异常 —— 只有当有人真的给会话登记过模型，
> 用量才归因得起来。这一点写在页面上，而不是靠"默认模型"把空缺填满。

### 7.6 前端：事件委托与 CSP（P1-3 / 3.4）

后端安全头（`app/http/security-headers.mjs`）从 P0-D 起就下发 CSP，但 `script-src` 一直带着
`'unsafe-inline'` —— 因为前端满屏内联事件属性。**内联脚本一旦放开，XSS 防护基本就没了**：
攻击者只要能把一段 `<script>` 或 `onclick` 送进页面就能执行。0.9.0 把这条堵上。

做法是把"可执行代码"从 HTML 属性里搬走，属性里只留**数据**：

| 原先 | 现在 | 说明 |
|---|---|---|
| `onclick="App.foo('x')"` | `data-act="foo" data-a1="x"` | 由文档级委托派发到 `App.foo(...)` |
| `onchange="App.bar(this.value)"` | `data-change="bar"` | 委托把元素当前值作为唯一参数传入 |
| `onclick="location.hash='#/x'"` | `data-nav="#/x"` | 委托改 hash |
| `<script>…</script>`（首屏） | `<script src="./boot.js">` | 同源外链脚本，仍在首次绘制前执行 |

要点与取舍：

- **委托只挂一次**（`bindDelegates()`，挂在 `document` 上），重绘不必重新绑定 ——
  顺带消掉"重绘丢监听 → 点了没反应"这一整类 bug。
- **参数统一是字符串**。布尔靠 `"true"`/`"false"` 还原：本项目**需要布尔的参数只有"启停"一类**，
  其余字符串参数的取值里不会出现裸的 `true`/`false`，因此不产生歧义（这条前提写在 `public/app/40-delegate.js` 里）。
- **`javascript:` URI 也归 `script-src` 管** —— 这是最容易漏的点。页面里 3 个
  `<a href="javascript:void(0)">` 若只改 `onclick`、不改 `href`，会变成**点了没反应且不报错**的链接。
- **`style-src` 的 `'unsafe-inline'` 明确保留**：页面仍有内联 `style="..."` 属性（当前 **130** 处），
  而 CSP 里内联样式**属性**同样受 `style-src` 管辖。内联样式能造成的危害与内联脚本不在一个量级，
  为它做上百处高风险改写性价比很低 —— 所以**保留并写在注释里**，不假装已经去干净。
  ⚠️ **数字是"活的"**：3.4 交付时是 **122** 处，3.6 加附件条时 `＋附件` 的隐藏
  `<input type="file" … style="display:none">` 又添了 1 处 → **123**。
  这个漂移当时没被发现，说明"只写数字、不加护栏"是不够的 ——
  因此 0.10.0 把**当前计数冻成断言**（见下），**加一处就得改一次断言，改断言这件事本身必须被看见**。
  ⚠️ **0.16.0：119 → 138**。「管理闭环」四处新 UI（配额行内编辑器、MCP 登记表单、
  模型条目编辑器、平台设置页的来源徽标与禁用态）有意新增 19 处内联样式，
  断言基线同步上调并在 `test-frontend.mjs` 注释里写明缘由；后续仍"只减不增"。
  ⚠️ **0.16.2：138 → 134**。拆除「平台主动发起工具执行」功能族（审批页 / 待审批面板 /
  工具策略表整体下线），随之消失 4 处内联样式（审批单状态徽标、策略表行内输入等）。
  只减不增，护栏语义不变。
  ⚠️ **0.17.0：134 → 130**。删除「会话与回合」开发者页（日常对话与管理已全在对话工作台），
  随之消失 4 处内联样式（面板间距、选中行高亮、提交区与事件区间距）。
  只减不增，护栏语义不变。
- **这不是"前端变安全了"**：鉴权始终只在服务端做（`public/app/10-routes.js` 文件头第 4 条）。本次改的是
  "XSS 的弹药供给"，不是授权模型。

**回归怎么钉住它**（`test-frontend`，4 条）：静态断言"不得再有内联事件属性 / `javascript:` URI / 内联 `<script>`"，
并把 `data-act` / `data-change` 里的名字与 App 上真实存在的方法**逐一对账**（打错一个字母的表现是
"那个按钮点了没反应"，比抛异常更难发现）；三条**真实派发**用例验证委托把参数（含布尔还原、冒泡、双参数）
原样送到方法上。`test-http` 另加端到端断言：真实响应头的 `script-src` 无 `unsafe-inline`、
`boot.js` 可取到、`index.html` 无内联脚本。

### 7.7 工作台最后一公里：停止 / 重生成 / 附件 / 会话挂载知识库（P1-3 / 3.6；附件的图片通路 0.10.0 补齐；知识注入 0.14.0）

> ⚠️ 本节原含第五项**会话内检索**，**0.21.7 整块删除**（路由 + 仓储 + 前端动作 + 面板 + 高亮 + 测试）。
> 下表那一行保留为决策证据（当时为什么把它放服务端），删除理由见 §7.12.6 第四节。

五条路由（`scope: session`），能力分别是 `session:execute`（取消）/ `session:write`（上传、删除、**改挂载**）/
`session:read`（列表、下载、检索）：

| 端点 | 做什么 | 关键边界 |
|---|---|---|
| `POST /api/kernel/sessions/:id/cancel` | 通知上游取消本轮（带 `turnId`） | **"停止"是两件事**：① 断开读取（前端 abort，不需要这个端点）② 通知上游别跑了（省的是上游算力）。响应里 `upstream:{attempted,ok,error}` 是**独立字段** —— 把两者混成一个 `ok` 就是偷换"平台已停手"与"钱不再花" |
| `POST /api/kernel/sessions/:id/attachments?filename=` | 上传（**原始字节**，元数据走 query） | 不用 multipart：手写一个"差不多能用"的解析器，出错方式是**静默截断或错位**，比不支持更糟。上限 8MB，超限 **413**，不静默截断。落库的 `mime` 取**内容嗅探**结果（图片按魔数），**不采信**浏览器声明 |
| `GET  /api/kernel/sessions/:id/attachments[/:attId]` | 列表 / 下载 | 响应**不含 `stored_path`**；下载头同时给 ASCII 兜底名与 `filename*=UTF-8''`（HTTP 头值只允许 ASCII，只给中文名会 500） |
| `DELETE /api/kernel/sessions/:id/attachments/:attId` | 删除（**元数据 + 字节**） | 只删元数据是**假删除**；删不掉要如实回报 `bytesDeleted:false` + 原因 |
| ~~`GET  /api/kernel/sessions/:id/search?q=`~~（**0.21.7 已删**） | ~~会话内检索~~ | **放服务端**：工作台一次只回放最近 2000 条事件，纯前端过滤会在长会话里给出"搜不到"的**错误结论**。LIKE 通配符转义，并只认"可见文本（正文 / 推理增量）"命中，把只命中结构化字段的假阳性排除且如实报条数 |
| `POST /api/kernel/sessions/:id/kb` | 改本会话挂载的知识库（`{kbIds:[…]}`，0.14.0） | **挂载 ≠ 可见**：写入口做**可见性校验**并**点名拒绝**不可见 / 不存在的库（只为"当场发现问题"，不是安全边界），而**检索侧永远按库级 ACL 再判一次** —— 库随时可能被收紧为 `restricted`，那时检索结果被**如实丢弃**而不是报错。上限 **8 个**（超出截断）、去重 |

**会话挂载知识库：为什么是"注入"而不是"工具"（0.14.0）**

知识库此前是一个**孤立的检索工具**（能在知识库页搜到、能核对出处，却没有任何办法让**对话**用上它）。
接通它有两条路：把检索注册成**平台侧工具**让模型自己调用，或在**平台侧把检索结果拼进本轮上下文**。
本项目走上坡第二条，理由是前者**根本走不通** —— 上游 wire 契约**不提供平台侧工具执行**
（`assessment-0.11.0.md` §B7 实测：工具执行是上游的**进程内**扩展点，不在对外 wire 上），
而 0.10.0 的附件正文注入**已经证明**"平台能往 `content` 里写字"这条路成立。于是同一条路用来注入知识：
`runTurn` 在拼附件**之前**先拼知识（所以顺序恒为 `用户原文 → 知识段 → 附件段`，**用户原文永远在最前**），
对已挂库检索 **top-k 5**、命中片段按 `[n] 出处` 排列、合计 ≤ **16KB**，并对模型附一段
"优先依据这些资料 / 资料不足要如实说 / 引用请带编号"的说明。
⚠️ 三条边界写在代码里也写在页面上：① **不是 agent 式多轮自主检索**（问一句查一次，不会再追一次）；
② **没有 rerank**（按检索分排序取前 5）；③ 检索**同步**发生在回合开始时，会占掉一点"首字之前"的时间。
失败 / 被拒**不打断对话**：`mode` / `notes` 如实回报、前端**照实呈现**（把"权限被拒"与"真的失败"**分开**，
把正常结果渲染成故障属**夸大**，与隐瞒同样是失真）。

**注入的机制与"两个真相"的处理**

`runTurn` 发出去的一轮 `content` 是**三段拼起来的**：`用户原文` + `知识段` + `附件段`，
每段前放一个**分界标记**：知识段 = `kernel.mjs` 的 `KB_INJECT_BEGIN`（`<<<STI-KNOWLEDGE>>>`）；
附件段 = 同文件的 `ATTACH_INJECT_BEGIN`（`<<<STI-ATTACHMENTS>>>`）；
前端识别用的副本在 `public/app/84-workbench.js`（`WB_KB_MARKER` / `WB_ATTACH_MARKER`）。
因此落库的 `turn-start.text` 是"用户输入 + 知识段 + 附件段"，而工作台要把它回放成**用户气泡**：

- 整段回放是**说谎**（用户没说这些）；
- 把 60KB 文件糊进气泡又没法用；
- 于是**显示层化简**：气泡 = 用户真打的字 + 一句"＋N 个附件已注入"（知识命中另给一张**知识卡片**），
  而「轨迹」里仍是完整原文 —— **数据层不动**，因为那才是平台实际发出去的东西。

附件数**从落库原文里数出来**（数 `<attachment ` 出现次数），不另存字段：
回放时不需要任何额外状态，且"标记在 = 当时真注入过"是同一份事实的两个视图，不会互相矛盾。
⚠️ **剥注入段必须"一次切干净"，不能按标记分别剥两次**：前端用一个**通用形态**正则
（`WB_INJECT_MARKER_RE = /<<<[A-Z0-9]+-(?:KNOWLEDGE|ATTACHMENTS)>>>/`）认**第一个**出现的标记后截断。
若写成"先找附件标记、再找知识标记"分别处理，当一轮**同时**注入知识与附件时，只要顺序稍变，
**知识段就会留在用户气泡里被当成他自己打的字**（实测踩到过）。写规范名、认**形态**，同时也兼容
更名前（`<<<ZZZ-KNOWLEDGE>>>` 那种前缀）落库的老会话。
三对标记字面量**必须一字不差**（服务端 ↔ 前端），由契约对账用例提取两侧常量后比对钉住
（`tools/test-core.mjs` 与 `tools/test-frontend.mjs` 各有一条，附件标记与知识标记**都覆盖**）——
**声明与实现不许分家**。

**附件的三条通路（0.10.0 更正版）**

⚠️ 0.9.0 在这里写过一句**假话**：「平台没有接通上游的"上传一个新附件"通道（契约里的 `readAttachment`
是"读上游**已有**的附件"）」。真相是**写入通道一直在** —— 它就在 `submitTurn` 的 `content`
内容块数组里（上游 `PromptContentPart` 定义了 `{type:'image', mediaType, data:base64, name?}`），
而我们的 `toBlocks()` 对数组**原样透传**。当时只看了"读"的 `readAttachment` 就断言"没有写通道"，
是**只看了契约的一半**。

上游对**图片**与**通用文件**是两条根本不同的通路：

| 附件类型 | 结局 | 通道 |
|---|---|---|
| **图片** PNG / JPEG / WebP / GIF（按**内容魔数**识别，不看扩展名） | **真的送给模型**（`{type:'image'}` 内容块） | `submitTurn` 的 `content` 数组（**0.10.0 已接通**） |
| **文本类**（单文件 ≤ 64KB，本轮 ≤ 96KB） | 正文**注入**本轮上下文 | 平台自己拼引用块（非上游通路） |
| **其余二进制**（PDF / ZIP / DOCX…） | **只登记、展示、可下载** | ❌ **经实测（2026-10-02）当前上游 wire 契约不提供该通路**：写入 `fileUploads/upload` 可用，但返回的 `FileAttachmentRef` **不含任何路径**（`attachmentId` 是内容寻址 id，类型定义明写 "never a filesystem path"），且 wire 的 `session/prompt` **不接受 `{type:'file'}` 内容块**（`PromptContentPart` 仅 `text`/`image`）；只读侧 20 个候选方法全 404。详见 `roadmap.md` 的 B 档结案 |

**没送出去的部分，必须点名**：`attachments.skipped[]`（带 `reason` 与 `note`）逐条点名，
页面**如实标注结局**（"已作为图片块送给模型" / "正文已注入" / "不提交"）。
**图片送不出去只有两个原因**，都必须如实说、不许吞：`upstream_unsupported`（垫片声明该内核不支持图片）
与 `image_budget`（本轮合计超 10MB）。**宁可少做，也不谎报"文件已交给模型"。**

**图片通路为什么必须按魔数嗅探**：上游准入会**校验字节与声明类型是否相符**，不符则**整条消息失败**
（连文本一起不发）。所以 `sniffImageMediaType()` 只认文件头（PNG 八字节签名 / JPEG `FF D8 FF` /
GIF `47 49 46 38`+`'7'|'9'` / WebP 的 `RIFF` 与 `WEBP` **两段都判**），认不出就返回 `''`，**绝不猜**；
且 `toImagePart()` 对非白名单 `mediaType` **直接抛错**。单张上限刻意**不另设**（等于上传上限，设了永不触发 = 死代码）。

**返回给 provider 的 `fromSeq` 与"本轮起点"**

`runTurn` 传给 `streamTurns` 的 `fromSeq` 是"**平台库已落库**的最大 seq"，
而平台库的 seq 与上游事件流的 seq 是**两套编号**。上一轮若被停止/超时截断，
平台只落了前一半，这个数就小于上游已产出的事件数。所以——
**"哪些事件属于本轮"只能由 provider 自己回答**：真实 provider 用 `submitTurn` 时记下的 `turnBase`，
测试替身用 `s.lastTurn.startSeq`，两者都**刻意不认**调用方给的 `fromSeq`（只在没走过 `submitTurn`、
比如补看历史会话时退回它）。这条语义必须两边一致，否则一次"停止"就会让此后每一轮都串上一轮的尾巴。

**回归抓出的缺陷（都是真实缺陷，不是补测试）**

1. **`usageRows` 恒为 1**（§7.5，`cost.mjs`）：未归因桶数的是分组行数而非记录数。
2. **工作台首次打开显示"未登记模型"**（`public/app/70-app.js`）：首次自动选中会话时漏调 `wbRefreshContext()`。
   这是一句关于**成本归因**的错误结论。
3. **测试替身串轮**（`tools/kernel-stub.mjs`，当时还叫 `mock-provider.mjs`）：一次停止污染此后每一轮（见上）。
4. **中文名附件下载必 500**（`kernel.mjs`）：HTTP 头值里放了中文。
5. **"请求体过大"变 500**（`errors.mjs`）：`toHttpError` 只认 `AppError`，
   而读体函数从 M0 起抛的是带 `{code,httpStatus}` 的普通 `Error` —— 413 被吞成 500，
   调用方看到"服务器坏了"而不是"该传小一点"。附件上传把这条路第一次真正走到才暴露。
6. **工作台的 `notice` 写了却从不渲染**（`public/app/70-app.js`）：四处提示（含"模型登记"这条
   关系到成本归因的关键反馈）都写进 `State.wb.notice`，而**没有任何地方渲染它**。

教训：这 6 条里有 3 条（2 / 5 / 6）是**"写了但没接上"**型缺陷 ——
代码不报错、日志干净、页面看着正常，只有断言到"用户最终看到什么"才抓得住。

### 7.8 前端分片与加载顺序（0.11.2）

前端**不再是单文件**。原先 `public/app.js` 一个文件 4,779 行（全仓最大的维护负担），
0.11.2 起按域拆成 `public/app/*.js`，由 `index.html` **顺序**加载：

| 文件 | 内容 |
|---|---|
| `10-routes.js` | 路由表（页面 / 导航 / 标题 / 权限要求的唯一真源）、资源与动作标签 |
| `15-dialog.js` | 应用内对话框（`Dlg`：confirm / prompt / pick / notice；0.15.0 取代原生 `prompt`/`confirm`/`alert`，见 §7.9） |
| `20-state.js` | 全部前端状态（`State`） |
| `30-util.js` | 小工具：转义、`card` / `kv` / 加载与错误态 |
| `40-delegate.js` | 事件委托（§7.6 的前提） |
| `50-boot.js` | 启动、登录 / 初始化流程与对应页面 |
| `60-page-platform.js` | 概览 / 系统状态 / 接口清单 / 契约与映射 / 中间件 |
| `61-page-identity.js` | 账号管理 |
| `62-page-org.js` | 部门 / 用户组 / 角色 / 凭据 / 我的账号 |
| `63-page-knowledge.js` | 知识库与检索 |
| `70-app.js` | `App` 对象：动作层（列表页 / 表单页的数据加载与写操作） |
| `71-app-workbench.js` | `App` 对象：**对话工作台**动作层（25 个 `wb*` 方法；`Object.assign(App, {…})` 归并回同一个对象） |
| `80-pages-governance.js` | 写操作收口 / 顶栏 / 审计 / 配额与用量 / 成本 |
| `81-pages-capability.js` | 能力三页 + 备份恢复页 |
| `82-pages-model.js` | 模型中心与单价 |
| `83-pages-ops.js` | 调度中心与通知渠道 |
| `84-workbench.js` | 对话工作台（**渲染**；动作在 `71-app-workbench.js`） |
| `90-start.js` | 渲染入口与启动（`bindDelegates()` / `hashchange` / `window.App` / `boot()`） |

四个必须知道的规矩：

1. **经典脚本，不是 ES module。** 各片共享同一个全局作用域（顶层的 `const` / `function` 落在
   全局词法环境里），因此彼此可以直接引用，**没有 import、没有构建步骤** —— `node --check` 与
   回归里的 `vm` 依旧能直接跑，这是"可审计"这条红线的底座。
2. **`index.html` 里的顺序就是依赖顺序**（不是文件名字母序）。`test-frontend` 直接解析
   `index.html` 取分片清单，并断言"顺序 == 文件名的数字前缀升序" —— 顺序被挪动就会红。
3. **每片保留自己的 `'use strict';`**。⚠️ 因此回归里**必须逐片执行**：把十几片拼成一个大字符串再跑，
   第二片起的那句 `'use strict'` 会退化成普通字符串表达式，后半段**静默脱离严格模式** ——
   那等于"回归跑的语义和浏览器不一样"，比不跑更糟。
4. **`App` 对象跨两片，但仍是同一个对象**（0.13.0 拆完）：`70-app.js` 定义本体（列表页 / 表单页动作，
   ≈1,200 行），`71-app-workbench.js` 用 `Object.assign(App, {…})` 把工作台域（25 个 `wb*` 方法）挂回来。
   ⚠️ **拆文件 ≠ 换命名空间**：`40-delegate.js` 的事件委托与页面渲染都按 `App.<action>` 取函数，
   若把工作台另起一个命名空间，等于把"哪个动作在哪"散到三处。
   这条约束由回归钉住：那条"`App.x()` 用到的每个方法都真的定义在 App 上"的用例，
   现在**同时解析 `const App = {` 与所有 `Object.assign(App, {…})` 块** ——
   它正是被这次拆分改红的（只认前者会让搬走的 25 个方法全被判成"未定义"）。

---

### 7.9 内核接入向导（0.15.0）

背景：0.14.1 之前，"接真实内核"唯一的办法是 **SSH 上服务器 → 手改 `data/config.json` → 重启**，
而那个地址里还夹着一个令牌。对企业的 IT 来说这是最典型的"第一天就撞墙"。

现在在概览页（以及管理员首次登录时的阻断式引导里）三步做完：**粘贴地址 → 检测连接 → 保存并启用**。

**① 检测是独立的一步，不是保存时顺带做的。** 它按**用户排查问题的顺序**给结论：
地址 → 连通 → 识别 → 鉴权 → 版本。六类失败给**六个不同**的下一步 ——
分类错 = 让人去改没坏的东西。纯逻辑抽成 `app/kernel/connection-config.mjs`
（可穷举回归 + 文案**单一真源** `KERNEL_STATE_TEXT`），联网那一步单独留在 `probeKernelConnection`。

| 状态 | 结论 | 下一步（节选） |
|---|---|---|
| `bad-origin` | 地址本身不合法 | 改地址格式 |
| `unreachable` | 连不上这个地址 | 查地址 / 端口 / 防火墙 |
| `not-kernel` | 这个地址有响应，但**看起来不像内核** | 确认这是内核的地址，而不是同机的别的服务 |
| `need-token` | 是内核，但没带令牌 | 补令牌 |
| `token-rejected` | 令牌被拒绝 | 换令牌（多半是上一次启动留下的） |
| `forbidden` | 该地址要求浏览器会话鉴权 | 换一种接入方式 |

**② 保存前一律先探测，不通过就不保存（0.21.5 收紧）。** 从前只拒 `unreachable` / `not-kernel`
这两种"当场被证伪"的状态，留下一个「跳过检测直接保存」（`force`）的口子；现在**检测没通过就存不进去**，
一律 `409` + 完整诊断一起带回。
用 `ctx.fail` 而不是 `throw`：统一错误出口刻意只回 `code + message`，而这里必须把诊断带回去
（前端要拿它显示"卡在哪一步"，不该为了显示结果再探一次）。

为什么把那个口子堵上：它唯一的作用是让用户把一条当场已被证伪的配置存进去，
换到的是"保存成功、平台却没接入上"——**那是最难自查的一种失败**（界面会显示"已保存"），
而它换来的好处只是少点一次检测。前端把保存键置灰只是把话说在前面，判据在服务端。
（`force` 字段今天仍会被接收但不产生任何作用 —— 老前端还在传它；回归钉着"传了也一样被拒"。）

**③ 令牌以密文落盘**（AES-256-GCM，键名 `dshTokenCipher`，明文键在同一事务里清掉）：
**Windows 上文件权限不可靠**，所以这里选的是"密文"而不是 `0600`。
界面、日志、`/api/system/status` 都不回显它。

**④ 两个端点都要 `system:write`**：服务端主动去连**调用方指定的地址**是 **SSRF 形状**，不开给普通登录用户。

| 端点 | 做什么 | 关键边界 |
|---|---|---|
| `POST /api/system/kernel/probe` | 只探测，不改动任何配置 | 探测结果如实回（含 HTTP 状态 / `Server` / 内容类型）；**失败的分类不准**比不分类更糟 |
| `POST /api/system/kernel/config` | 写 `data/config.json`，令牌密文落盘，**保存即生效**（0.21.3 起热切换，见 §7.12.3） | ① **先探测，不通过即 409**；② 门面内部持可变 state，换内核 = 原子写一次 state —— 门面引用不变，所以路由不用重接。**仅两种情形仍需重启**：被环境变量覆盖 / 重新装配抛错 |

**⑤ 保存成功 ≠ 内核可用。** 响应里把两件事**分开报**：`saved`（写盘了没有）与
`switched.ready`（当场切换之后内核能不能用）。后者为假是真实存在的一种结果
（检测通过之后内核掉线了），界面照它说话，不替它乐观 —— 也正因如此，
前端的"接入成功就关掉弹框并进首页"用的是 `switched.ready`，不是"请求返回 200"。

**⑥ 「需要重启」这条提示曾经是个假警报。** 判"配置改了但没生效"比的是两个**客观值** ——
"运行中内核实际连的地址 vs 文件里写的地址"，不用标记位。但前提是**两边真是同一类东西**：

- `kernel=auto`（那个已删的开关）是**解析策略**不是模式，与运行中的 `external` 永远不相等 ⇒
  每个默认部署都常亮一条永不消失的提示。0.21.4 把"模式"整个概念删掉后，比较对象只剩地址一项。
- 0.15.0 之前所有部署都把令牌**内嵌在地址里**（`…?token=xxx`），与归一化后的运行地址恒不相等。
  修法：`normOrigin()` 丢掉 query / hash。

> **恒真的提示等于噪声。** 一条永远亮着的告警，等于把真正该看的那条也一起关掉了。

---

### 7.10 应用内对话框（0.15.0）

**问题**：到 0.15.0 之前，全站 19 处行内动作（删库 / 删文档 / 删凭据 / 删用户组 / 删配额 /
删任务 / 删通知渠道 / 注销 MCP / 改角色 / 改归属 / 改组成员 / 重置口令 / 拒绝审批 / 一次性 API Key …）
用的都是浏览器原生的 `window.prompt` / `confirm` / `alert`。对一个**要交付给企业**的产品，这有三宗罪：

1. **让人手输标识符。** 「改角色」要输 `member,viewer`，「改组成员」要输一串账号名 ——
   原生 prompt 只能给一段**纯文字**提示，**给不了选项**。用户看不到有哪些可选，输错一个字整条请求被拒，
   而错误提示还只能靠服务端返回。
2. **新口令不遮蔽。** 「重置口令」用原生 prompt 收口令，屏幕上**明文**显示，且没有二次确认。
3. **不可样式化、阻塞整页、还可能被静默丢弃。** 原生弹窗与主题/品牌完全脱节；
   在嵌入式浏览器与部分客户端里会**静默返回 null** —— 用户看到的是"点了没反应"。

**做法**：弹层是**状态**（`State.dlg`），由 `render()` 渲染，按钮走既有事件委托
（`data-act` / `data-change`，§7.6）。API 在 `public/app/15-dialog.js`：

| 方法 | 语义 | 取消时的返回值 |
|---|---|---|
| `Dlg.confirm({title, body, ok, danger})` | 危险动作的二次确认 | `false` |
| `Dlg.prompt({title, label, value, type, validate, required})` | 收一个文本/口令 | `null` |
| `Dlg.pick({title, options, multiple, selected, required})` | 从**渲染出来的选项**里选 | `null` |
| `Dlg.notice({title, body, mono, warn})` | 告知，含"只显示一次"的明文 | `null` |

三条必须守住的规矩：

1. **取消是 `null`，不是 `falsy`。** ⚠️ 这条不是洁癖：「改归属」里
   「（不归属任何部门）」的取值就是**空串**，那是一个有效选择。旧代码把
   `prompt(...) || ''` 的返回值直接当"提交值"用，于是"点拒绝审批 → 在弹窗里按取消"
   变成**以空原因把单子拒了**（一条真实的审计污染）。所以判据一律写 `=== null`，
   且回归里专门有一条钉这个语义。
2. **每个 `render()` 分支都要拼上 `dlgOverlay()`。** 漏掉一个分支（`boot` / `setup` / `login`
   这三个"全屏视图"是提前返回的）不会让样式变难看，而是让弹层**根本没被渲染** ——
   等它答复的那个 `await` 永不 settle，整条动作链静默挂住。有回归同时钉**源码装配点**与**行为**。
3. **校验失败不关窗。** 把错误写进弹层、留在原地让人改，比"关掉再从头来一遍"强；
   弹层里的值在重绘时由状态回填（与内核接入表单同一条纪律，见 §7.9）。

**顺带的三处收益**：

- **回归能真的驱动它了。** 原生 `prompt` 在 `vm` 垫片里只是一个"返回 null 的桩"，
  无论怎么改都测不出真实流程；而弹层是**渲染出来的 HTML**，"弹层里写了什么、有哪些选项、
  按钮叫什么"全都成了可断言的事实（`test-frontend` 的 `answer()` 助手）。
- **`window.Dlg` 显式挂出。** 分片是经典脚本，顶层 `const` 只进全局词法环境、
  不会成为 `window` 属性 —— 与 `window.App` 同一个理由（排查"点了没反应"时，能在控制台里
  驱动一次弹层很值钱）。
- **原生弹窗归零后，"哪条动作是危险的"这件事第一次有了统一的表达**（`danger: true` 渲染成
  红色确认键），而不是散落在 19 句文案里靠措辞提示。

---

### 7.11 工具不是能力：它只以事件流事实存在（0.21.10 重写）

> **本节在 0.20.0 时叫「清单与调用的口径：可用 ≠ 已用」，主题是"如何把工具调用与工具清单对账"。**
> 0.21.10 用户裁定：**「工具来自会话事件流投影，去掉关于工具的所有内容」**、
> 「工具是在内核自己调用，不用单独写这个能力，而且不会单独列出来有哪些工具」。
> 于是"对账"这件事的**两端之一（清单）不存在了**，整节随之重写。
> 下面保留的只有仍然成立的那一半：工具调用是**事件流事实**。

**工具的定位：内核自己调用的，不是平台治理的对象。** 与 Skill 的关键差别：

| | Skill | 工具 |
|---|---|---|
| 有登记表吗 | 有（`skills` 表，可安装 / 卸载 / 启停 / 升版本） | **没有**。工具随内核与插件而来，平台不登记 |
| 有清单吗 | 有（`listSkills()` 契约方法 + 登记表双来源） | **没有**。契约里**没有** `listTools`，上游也没有这个 RPC |
| 能被单独停用吗 | 能（登记开关 + `deny:skill` 绑定） | **不能**。可见性治理只剩连接 / 服务两级 |
| 怎么被看见 | 能力清单页、来源页 | 会话的「轨迹」页签里的**工具卡**（逐条渲染） |
| 事实落在哪 | `skills` 表 | `events` 表里的 `tool-call` / `tool-result` 事件 |

口径一句话：**"调过哪些工具"是一个会话事实，不是一个平台资源。**
它不需要登记、不需要对账、也没有"应该有哪些"的期待值 —— 因此平台不该摆出一份清单让人去核对。

| 层次 | 数据来源 | 界面落点 |
|---|---|---|
| **可用**（清单） | `GET /api/capability/skills` → `registry`（技能登记表）+ `kernel.skills`；`GET /api/capability/mcp` → `registry`；插件清单随 skills 响应下发 | 能力清单页（Skill / MCP / 插件三段）；来源页的按来源分组 |
| **已用**（调用） | 事件流里的 `tool-call` / `tool-result` 事件（落库语义事件；实时与回放共用同一份 `msgs`，不是两套） | 工作台会话框的「轨迹」页签：工具卡 |

⚠️ 仍然有效的两条口径：

1. **只做精确同名匹配，不按名字猜血缘。** 上游 `tool/call` 事件里**根本没有**来源字段
   （录制下来的真事件只有 `name` / `arguments` / `callId`），因此任何"按前缀 / 子串推断
   这个工具来自哪个 MCP 服务"的做法都是**造事实**（`fs.read` 进不了此列）。
   **契约层刻意没有加 `tool.source` 字段**：一个恒为 null 的字段只会制造"字段在、事实无"
   的假象（与 `normalizeEvent` 用 `known:false` 而不是丢弃未知事件是同一种取舍）。
   ⚠️ 0.21.10 之前这条口径落在**工具卡的来源徽标**上；徽标已删（它要一份不存在的清单才能算），
   于是这条口径现在只在**契约层**生效：`tool` 事件不带来源，谁都不许替它补一个。
2. **假差距不许凑。** 内核 Skill 清单为空是"上游没有报"（如实标注来源与 `error`），
   此时**不**把登记表整个列成"未探测到"；只有两侧都报出了东西，差距行才成立
   （差距行是"内核报了、但少了一条"，不是"内核没报"）。

⚠️ 0.21.10 **删除**的东西（连同理由，避免有人"觉得少了什么"又加回来）：

- `tools` 表、`listTools` 契约方法、`/api/capability/tools/:name/enabled` 端点、
  `registryTools` / `kernel.tools` / `toolsNote` / `toolsError` / `streamSourced` 字段、
  能力清单页的工具段、来源页的工具来源分组、导出包里的 `tools` 段、
  工具卡的来源徽标、`App.toggleTool`、以及前端为徽标而拉的那次 `GET /api/capability/skills`。
- **导入端的例外**：`tools` 段**静默收下**（不报错）。旧导出包里有它是历史事实，
  为它报错等于让一次"格式升级"废掉已经导出去的资产。
- **没有删**：工具卡本身（会话事实）、插件清单（`listPlugins()`，它是"上游装了哪些插件"，
  与工具是两码事）、MCP 可见性闸（它从前**借用**工具判定 ——
  `toolVisibleNow('mcp:' + name)` —— 现在走自己的 `mcpVisibleNow`，行为逐字不变）。

---

### 7.12 工作区树与访问档（0.21.0；权限部分已于 0.21.6 整块删除）

对话工作台此前是**一条扁平会话列表**，会话之间唯一的组织手段是改名。0.21.0 把左栏换成
**工作区树**（工作区 → 会话 → 「未分组」桶），并在输入卡上补齐模式与推理等级选择器。
参考对象是原生 Harness 的首界面。

⚠️ **两条口径先立在这里，后面所有实现都从它们推出来**：

1. **工作区不是上游实体。** 实测上游**没有**工作区 RPC（只有 `workspace/archiveSession`
   这种会话级归档）。因此工作区是**纯平台侧的组织概念**：本平台从不向上游同步工作区，
   上游也不知道它的存在。删工作区只删本地组织容器，会话原地保留（见下文"不级联"）。
2. **工作区是纯组织容器，"谁能做什么"由组织角色说了算。**
   0.21.0～0.21.5 期间平台在工作区上还挂过一套**三档访问权限**（仅可查看 / 工作区内修改 /
   完全权限 + `open`/`restricted` 可见性 + 工作区级授权名单）。**0.21.6 已整块删除**，
   理由与"删掉之后谁在把门"写在 §7.12.5。
   与上游 Agent preset（`standard/ptc/minimal/cordis`）的区别仍然成立：那是"内核怎么跑"，
   不是"谁能做什么"，两者不许共用同一个下拉。

| 数据 | 位置 | 说明 |
|---|---|---|
| 工作区 | 表 `workspaces`（迁移 `0021`；`visibility` 列由迁移 `0023` 删除） | `id / tenant_id / owner_user_id / name / cwd / description / created_at / updated_at / archived_at` |
| 会话归属 | `agent_sessions.workspace_id` | 空 = 「未分组」桶。**删除工作区时置空，不级联删会话** |
| 推理等级 | `agent_sessions.reasoning_effort` | 0.21.0 前它只透传给上游、**不落库** —— 重启后"这个会话用什么推理等级"就丢了 |
| 落地会话 | `agent_sessions` 一行，`kernel_session_id` **为空** | 初始化时在默认工作区里放一条，平台一进来就是个能用的样子（§7.12.5） |

**档位仍从会话能力推导**（`platform/workspace/visibility.mjs` 的 `levelFromRoles`）——
只是现在**唯一的输入是组织角色**（工作区级授权已删）：

| 档位 | 展示名（0.21.6 起只用于**服务端报错文案**） | 推导条件 | 内置角色推出 |
|---|---|---|---|
| `full` | 完全权限 | 有 `session:delete` | `owner` / `admin` |
| `write` | 工作区内修改 | 有 `session:execute` | `member` |
| `view` | 仅可查看 | 有 `session:read` | `viewer` |
| `none` | —— | 都没有 | 未知角色（**fail-closed**） |

用**会话能力**而不是新造一个 `workspace:*` 资源，因为档位的本义就是"能对**会话**做什么"；
新造资源等于让平台同时维护两套"谁能干什么"的真相。副作用是 `admin` 必须在
`permissions.mjs` 里**显式**拿到 `session:delete`（默认档 `'*'` 只给 read/write/execute）——
它不是给某条路由用的（删会话仍是 `session:write`），它的第一语义就是**"完全权限"这一档本身**。

⚠️ 删掉 `visibility` 与工作区级授权之后，从前那张**五条优先级的判定顺序表**
（`decideWorkspaceAccess`）**整段塌掉了**：`open` 工作区本来就只看全局角色，
`restricted` 的那几条分支全部随可见性消失。判定因此收敛成一行
`levelFromRoles(角色)` —— **不需要**、也没有新造一套替代机制。

**权限判定的分层**（与库级 ACL §6.1 同一条，理由也相同）：

| 层 | 判什么 | 落点 |
|---|---|---|
| 路由层（`capability`） | **租户级**能力：`session:read` / `session:write` | `app/http/routes/workspace.mjs`、`kernel.mjs` |
| 服务层（档位） | "**这个人**能不能动这个工作区 / 这条会话" | `platform/workspace/service.mjs`（`assertWorkspaceAccess` / `assertSessionAccess`） |

⚠️ **两个刻意的取舍，都请当成契约而不是疏漏**：

- **路由层的门只到 `session:read` / `session:write`，档位判定后移。** 若在路由上写
  `session:delete` 之类的重门，判定就不会发生在它该发生的那一层。**这个取舍在删掉
  工作区级授权之后依然保留** —— 它维护的是**分层本身**，不是某一套授权模型。
- **档位不够一律 403，消息里点名当前档位与所需档位**
  （"当前档位：工作区内修改，需要：完全权限"）。
  ⚠️ 从前还有一条"**不可见就回 404**"（受限工作区不确认存在性）—— 那条随可见性一起删了：
  工作区现在对全组织可见，404 在这里只剩"真的没有这个 id"一种含义。
  回归里有**反向断言**专门钉这个差别（member 改工作区必须是 403，不能是 404）。

**会话守卫**（`assertSessionAccess`）是档位唯一长牙齿的地方：
`view` = 读事件/导出/附件列表/检索；`write` = 发回合/选模型/挂库/传附件/改自己的会话；
`full` = 改、删**别人的**会话与移动他人会话。⚠️ **未分组会话（`workspace_id` 为空）一律放行** ——
档位只对"进了工作区的会话"生效，这是为了让升级到 0.21.0 时老会话的行为**逐字不变**。

**列表回显与动作守卫同源**：`sessionManageRight` / `manageRightsFor`
（`platform/workspace/service.mjs`）是"这条会话我能不能管"的**唯一判据** ——
`kernel.sessions.list` 用它回填 `canManage` / `manageNeed`，`kernel.mjs` 的
`guardWsOwnership` 用它放行。两边各写一遍这条规则迟早漂移，那时用户看到的就是
"按钮亮着、点下去 403"。这也是删掉工作区级授权之后**唯一**还需要"按工作区算一遍"的地方。

**模式与推理等级**：

- **模式来自内核**（`agentPresets/list` → `GET /api/kernel/presets`）。上游只回
  `id / order / isDefault`，**没有名称与描述** —— 名称是显示层的事（前端映射），
  平台**不发明**内核没有的模式；上游不可用时如实返回 `unavailable` 而不是 500。
- **推理等级落库**（`agent_sessions.reasoning_effort`），随"选模型"一起写。
  ⚠️ 它记的是「平台**要求**上游用的推理等级」，**不是**从事件里观测到的实际等级 ——
  与本平台对 `model_id` 的既有口径一致（§7.5）：不把平台的猜测写成"这个会话真的用了它"。

**其他两条行为口径**：

- **删除工作区不级联**：先 `detachSessions` 把会话的 `workspace_id` 置空（落回「未分组」），
  再删容器。删的是组织容器，不是里面的人；审计里记下 `detachedSessions`（挪出去几个）。
- **会话 `cwd` 继承工作区**：显式传了 `cwd` 以显式为准，否则取工作区的。
  工作区 = 会话的组织容器，而 `cwd` 是它最重要的属性（与原生 Harness 同语义）。

**回归钉在哪**（档位这种东西，没有反例就等于没有实现）：

| 钉子 | 位置 |
|---|---|
| 档位推导 `levelFromRoles`（含 fail-closed）、档位比较 `levelAtLeast`、迁移 `0023` 已删列 | `tools/test-core.mjs` |
| 端点形状、CRUD、空名 / cwd 超长 400、不存在 404、**member 改工作区是 403 而非 404** | `tools/test-http.mjs` |
| **档位用两个不同组织角色的探针**：`viewer`（只读）与 `member`（可写，但改不了工作区） | 同上 |
| 全组织可见（不再有"看不见就 404"）；三个授权端点已从路由表消失（管理员访问也 404） | 同上 |
| `canManage` 回显用**正反对照**（member 对自己的 true / 对别人的 false；admin 对别人的 true） | 同上 |
| 移动会话、删工作区不级联（`detachedSessions` 计数）、模式与推理等级落库回读 | 同上 |
| 默认工作区 + **落脚会话**播种幂等（独立租户 / 二次调用不再补 / 审计各恰一条） | 同上 |
| 树渲染、行尾「⋯ / ＋」、权限模块整块删除（渲染结果与 App 动作表**双向**反向断言） | `tools/test-frontend.mjs` |

⚠️ 探针为什么要一 `viewer` 一 `member`：只用一个 `viewer`，你验到的是**路由层 RBAC**
（它连 `session:write` 都没有，请求根本走不到档位判定那一层），那些断言会**永远绿**却什么也没钉住。

> 存档：0.21.0 那版还有一条"非法可见性必须 400 而不是 500"的钉子（`normalizeWorkspaceVisibility`
> 抛裸 Error，不翻译会被 `toHttpError` 收敛成 500）。那条随函数一起删了 —— 但**教训留着**：
> 纯函数抛的裸 Error 到了 HTTP 层会被当成"服务器坏了"，服务层要负责翻译成 4xx。

#### 7.12.1 行内「⋯」、判定同源、初始化就有默认工作区（0.21.1）

0.21.0 把树建起来了，但每一行都把动作**摊在面上**（工作区行：新建 / 改名 / 权限 / 删除；
会话行：改名 / 删除）。行本来就窄，按钮一多，工作区名和会话名先被挤没 ——
用户原话是"重命名、删除等按钮隐藏到一个工作区名称或者会话名称右侧，点击再弹出来"。
0.21.1 只做三件事，都是把 0.21.0 的骨架**收口**，不加新概念。

**① 行内「⋯」菜单：菜单是状态，不是 DOM 浮层。**

每行（工作区行、会话行、「未分组」桶）名称右侧只剩一个 `⋯`（`.wb-row-more`，带
`aria-haspopup="menu"`），点开才是一列动作。
> ⚠️ 0.21.1 当时的这一列是 `重命名 / 工作目录… / 工作区权限… / 删除`（会话行是
> `导出 / 移动 / 重命名 / 删除 / 工作区权限…`）。**0.21.6 收窄了：工作区菜单只剩
> `重命名 / 删除`**（「＋ 新会话」提到行上成为一个独立的「＋」按钮，另两项删除），
> 理由与完整对照表见 §7.12.5。下面讲的是**菜单这个机制**，与菜单里放几项无关 ——
> 机制本身一行没改。
开合状态就是 `State.wb.rowMenu = { kind: 'ws'|'session', id }` 这一个值，**不引入任何浮层节点**：

- 与全站"重绘即真相"同一条纪律 —— 没有独立的显隐生命周期，也就没有"状态里有、DOM 里没有"
  这种第二份真相。菜单内容跟着上一次重绘一起出来（`wbRowMenuOpen(kind, id)` 判定）。
- 因此它**能被 vm 层的回归直接驱动**：浮层的定位、遮挡、`z-index`、滚动跟随在 vm 层测不到，
  而这些恰恰是浮层最容易坏的地方 —— 用一个状态换掉一整类测不到的东西。
- **互斥天然成立**：一个 `rowMenu` 只能指一行，`wbToggleRowMenu` 再点同一行即收起。
  不需要"点别处关掉"的全局监听。点空白处（`40-delegate.js` 的 `if (!el)` 分支）顺手收起。
- **不误触外层**：`⋯` 挂在行**内部**，但事件委托取的是**最近的**带 `data-act` 的祖先 ——
  所以点菜单项不会顺手把会话打开（`.wb-session`）或切工作区（`.wb-ws-row`）。
  这是"不嵌套可点区域"那条纪律的具体用法，不是巧合。

**② 判定同源：列表回显的 `canManage` 与动作守卫调的是同一个函数。**

0.21.0 有个真实风险：列表按全局 `session:write` 亮按钮，而动作守卫按工作区档位放行 ——
在"我在这个工作区只有 `write` 档、这条会话却是别人建的"情况下，会亮出一个**点了必然 403** 的
按钮，用户读作"系统坏了"。修法不是把两处逻辑对齐一遍（那会漂），而是**只留一份判据**：

```js
// platform/workspace/service.mjs —— 唯一的判据
function sessionManageRight(tenantId, sessionRow, subject) { … }
```

`kernel.sessions.list` 用它回填 `canManage`，`kernel.mjs` 的 `guardWsOwnership` 用它决定放行；
`manageRightsFor` 是它的批量版，按「`workspace_id` × 是不是我的」去重（判定的输入只有这两样），
避免 N 条会话 N 次判定。**未分组会话 `need: null`、恒定放行** —— 与 §7.12 主体那条口径一致。

⚠️ 这条规则最容易写错的地方是"**自己的会话用 `write`、别人的用 `full`**"，
所以 HTTP 用例用的是**正反对照**：同一个 `write` 档用户，看自己建的会话 `canManage: true`、
看别人建的 `false`。只测一边（比如只测"别人的是 false"）在实现"一律要 `full`"时照样绿。

**③ 初始化就有默认工作区 —— 空树不是可接受的初始态。**

新装的平台里一个工作区都没有，左栏是一片空地：用户得先"想到要建个工作区"才能开始对话，
而这一步在原生 Harness 里根本不存在。所以**两个入口各播一次，都幂等**：

| 入口 | 位置 | 覆盖的场景 |
|---|---|---|
| 初始化向导走完 | `identity.setup.run` → `ensureDefaultWorkspace` | **新装**：装完立刻能建会话 |
| 启动时播种 | `main.mjs` → `ensureDefaultsForAllTenants` | **升级**上来的空库（老数据里一个工作区都没有） |

- **幂等靠"已有工作区就一步不动"**：`listWorkspaces(tenantId).length` 非空即返回 `null`。
  所以第二次启动不会多建、不会改名、更不会把用户改过的 `cwd` 覆盖回去。
- **播种失败不许把成功的初始化搞成失败**：向导里 try/catch 成一句 `workspaceNote`，
  照常返回 201 —— 默认工作区是**便利**，不是初始化的前置条件。
- 与 `schedule.ensureDefaultsForAllTenants` 同形：**只在实际服务模式做**，
  `--check` 保持只读（自检不该改库）。

**`cwd` 的默认值不写死**：`paths.mjs` 推导 `DATA_DIR/workspace`，可被 `STI_WORKSPACE_DIR` 覆盖。
刻意**不用 `process.cwd()`** —— 那会把"从哪儿敲的命令"变成一条持久配置，也会让默认值落在
用户的主目录上。0.21.1 时界面上「⋯」→「工作目录…」可改、`title` 里显示当前值。
> ⚠️ 0.21.6 起**建完之后就没有改 cwd 的入口了**（「工作目录…」删除）：它只在**建工作区**时
> 才真正重要（那时会问一次），事后改的场景极少，而它占着菜单会把"重命名 / 删除"淹掉。
> 要改就删了重建 —— 会话落回「未分组」，本体不丢。**长度校验仍在**（建工作区时走同一条）。
⚠️ `cwd` 决定上游**项目级能力**能读写哪一片文件系统，所以更新时加了长度校验（> 512 → 400）。

**顺带把模型与推理等级收进输入卡**：0.21.0 把模型选择器留在 `wb-head`、推理等级在输入卡 ——
两个"这个会话用什么"的选择器分居两处。现在同排在 `wb-compose-meta` 一行：
工作区 / 模式 → 模型 → 推理等级 → 归因徽标。

> ⚠️ **0.21.6：这一整段已随工作区权限模块删除。** 会话行的 `⋯` 里不再有「工作区权限…」，
> 也不再有 `wbGrantsPanelHtml`（面板本体一并删除）。下面这段留作存档，因为它记的两条
> 判断与"删除"这个决定直接相关：① **档位是派生值，绝不落到会话上存第二份** ——
> 同一个工作区里两条会话会给出互相矛盾的权限；② **能点的才做成能点的**，
> 禁用并写明原因，不留"看着能点、点了 403"的控件。第二条在删除后仍然到处适用
> （例：行尾「＋」在没有 `session:write` 时是禁用态，§7.12.5）。
>
> ~~**会话上的「工作区权限…」是就近入口，不是第二份档位。** 会话行的 `⋯` 里也有「工作区权限…」，
> 点它**先按服务端此刻说的 `workspaceId` 解析**，再展开那个**工作区**的面板（`anchorKind: 'session'`，
> 内容与锚在工作区行上时逐字相同 —— 同一个 `wbGrantsPanelHtml`）。
> 刻意不落到会话上存一份档位：档位是"某人在某工作区上被授了什么"的**派生值**（§7.12 主体），
> 落到会话上就成了第二份真相 —— 同一个工作区里两条会话能给出互相矛盾的权限。
> 三种态都摆明：`full` → 可点；`view` → **禁用并写明当前档位**；未分组 → 禁用并指向「移动到…」。
> **禁用而不是点了 403**，与 §7.12 主体"档位不够才 403"是同一条口径的界面侧表达。~~

**回归钉在哪（0.21.1 增量）**：

| 钉子 | 位置 |
|---|---|
| 列表回显 `canManage`：`view` 档 false → `write` 档**自己的 true / 别人的 false** → `full` 档 true；未分组 `manageNeed: null` | `tools/test-http.mjs` |
| 默认工作区播种：独立租户幂等、二次调用不改 `cwd`、审计**恰一条** `workspace.default.seed` | 同上 |
| 初始化向导走完即有一个能立刻用的默认工作区（`cwd` 形态 `.../workspace`、`ownerUserId` = 建组织的那个人）⚠️ 0.21.6 起再加一条：里面要有一条**落脚会话**（`visibility` / `myLevel` 两条断言已随模块删除） | 同上 |
| `⋯` 恒在、菜单展开后才有入口、菜单互斥；`wbNewSessionIn` 建在**那一行**的工作区；未分组桶只摆「新建」 | `tools/test-frontend.mjs` |
| 真机：对话框 Tab 陷阱**先展开会话行「⋯」**再点重命名 | `tools/test-browser.mjs` |

> ⚠️ 0.21.6 又动了这一节的三条断言，原因都是同一次删除：`wbEditWsCwd` / `wbSessionGrants` /
> 授权面板用例**整条删掉**（动作都没了），未分组桶那条从"只有「新建」菜单项"改成"行尾只有一个「＋」"，
> 而"view 档禁用态"改成"**没有 `session:write`** 时「＋」禁用"（档位不再由工作区决定）。
> 教训记在 §7.12.5 第五节：**删功能时，指向它的断言要么改写、要么一起删 —— 留着就是下一次的假红。**

⚠️ 最后一条值得单独说：`test-browser` 原来直接 `waitFor('[data-act="wbRenameSession"]')`，
把按钮收进菜单后它**必然超时**。这不是"多等一会儿"的问题，而是**入口在菜单里** ——
所以要改的是用例的**交互路径**（先点 `⋯`），而不是超时时间。
它是本轮唯一一个由真机层抓到的失败：vm 层只验证"渲染出的 HTML 里有没有这个按钮"，
只有真机层会真的去"找它、点它"。

#### 7.12.2 全屏视图与工作台样式（0.21.2）

**为什么工作台要从"卡片"变成"整屏"。** 0.21.0/0.21.1 的工作台仍是 `.content` 里的一张圆角卡片：
顶上挂着全站 `.topbar`、左边立着全站 `.sidebar`。三栏工作台（工作区树 / 对话 / 上下文）
再套进这两层外壳，真正留给对话的宽度只剩几百像素 —— 布局的"乱"不是配色问题，是**嵌套层级**问题。
原生 Harness 的形态是"进门即工作台"：左栏树 + 中间品牌页/对话 + 右侧上下文，**没有第二层导航**。

于是 `render()` 里多了一个**全屏分支**（别处一行没动）：

```js
const fullBleed = cur.id === 'workbench';
$('#app').innerHTML = fullBleed
  ? body + dlgOverlay() + kernelGuideOverlay()          // 不套 topbar() / .layout / .sidebar
  : topbar() + '<div class="layout">' + …;
```

配套的还有 `#app { height:100vh; display:flex; flex-direction:column; overflow:hidden }` ——
全屏页自己管滚动（`.wb-tree` 与 `.wb-stream` 各滚各的），页面本身不滚。
`__tests__` 里有一条钉子专门守它：落地页**不得**出现 `.topbar` 与 `.page-title`。

**左栏是三段固定 + 一段滚动。** 品牌头（`STI HARNESS` + 左栏开合钮）→ 「工作区」节头
（`⌕` 过滤 / `⟳` 重拉 / `＋` 新建）→ **树（唯一滚动区）** →
底部「管理后台 / 设置 / 账号条（名字 + 登出）」。`.wb-side` 是
`display:flex; flex-direction:column; overflow:hidden`，
`.wb-tree` 是 `flex:1 1 auto; min-height:0; overflow-y:auto`：**树自己滚，头部与底部不动**。

> ⚠️ 0.21.2 当时这两段之间还有「✦ 新会话」胶囊与「🧩 插件」两个入口，**0.21.6 已删**
> （理由与对照表见 §7.12.5）。删掉之后左栏变成"品牌头 → 节头 → 树 → 账号条"，
> 段数少了一段，`flex` 结构不变 —— 树仍是唯一滚动区。

⚠️ **底部那条账号条不是装饰，是补一个真实缺陷。** 「登出」此前**只存在于顶栏**里；
工作台在 0.21.2 变成全屏视图之后不再渲染顶栏 —— 于是**进了工作台就再也登不出去**，
只能先绕去「管理后台」或「设置」再点顶栏。整屏改动砍掉既有能力是不可接受的，
所以登出入口必须在这里有一个。它是被真机层抓到的（`test-browser` S6）：
成员登录后停在无权限的地址 → 回落到落地页（工作台）→ 那里找不到 `[data-act="logout"]`。
**vm 层看不见这类缺陷** —— 它只验证"渲染出的 HTML 里有没有某个按钮"，
而那条用例正好不经过工作台；只有真机层会真的去"找它、点它"。
**结论：把一页改造成"另一套外壳"，等于把原外壳承载的**全部**能力重新落一遍，
每落一处都要问"还有谁只住在被我拆掉的那层里"。**

两个易踩的细节：

- **图标不能随便挑符号。** 「插件」原先用 `⌗`（U+2317）——Windows 中文字体里没有这个字形，
  真机上渲染成豆腐块。换成 emoji `🧩`。
  （那个入口 0.21.6 已删，但教训留着：）凡是要"看起来像个图标"的字符，先想清楚字体有没有字形。
- **节头三个钮都要有 `title`。** `⌕` / `⟳` / `＋` 三个符号本身无语义，`title` 是它们唯一的标签
  （与 `wbToggleRail` 同一条道理，见下面 S19 的教训）。

**输入卡：徽片在卡外，选择器在卡内。**

| 位置 | 内容 | 语义 |
|---|---|---|
| 卡片**上方** `.wb-chips` | 有会话：工作区 / 模式两个**静态**徽片（服务端记下的）；无会话：**只剩模式下拉** | 新对话的形态 |
| 卡片内左下 `.wb-foot-left` | `＋` 附件 · 归因徽标 | 这一轮"往哪发、按什么算账" |
| 卡片内右下 `.wb-foot-right` | 模型 ▾ · 推理等级 ▾ · 圆形 `↑` 发送钮 | |

分工的判据是**"是不是事实核对"**：归因徽标陈述的是服务端已经定下的事，
所以放在左下、与选择器隔开；模型与等级是这一轮的输入，放在发送钮旁边。
**能点的才做成能点的**，不留"看着能点、点了 403"的控件。

> ⚠️ 0.21.2 当时左下还有一片**档位徽片**（`full` 档渲染成 `button`，点进该工作区的授权面板；
> 其余档是 `span` 并写明当前档位）。**0.21.6 连带删除**（工作区权限模块整体删除，§7.12.5）。
> 卡外那一行当时还有**无会话时的工作区下拉**，也一并删了 —— 它与左侧树是两个改同一件事的入口。
> 两条教训仍成立并已被后续复用：① "能点的才做成能点的"；② **同一个值不许有两个写入口**
> （写入口重复时，界面就没法回答"到底哪个算数"）。

下拉箭头用 CSS 内联 SVG data URI 画（`appearance:none` + 背景图），不引任何资源文件 ——
`img-src 'self' data: blob:` 本来就允许 data:，零依赖约束因此没有破。

**三处"空态噪音"改成不渲染。** 知识库条、附件条、消息流在"什么都没有"时一律 `return ''`：

- `wbKbStripHtml()`：无挂载且面板未展开、无忙碌、无错误 → 不渲染；
- `wbAttachStripHtml()`：无错误且列表为空 → 不渲染；
- `wbStreamHtml()`：无会话时只有**当前角色确实不能发起对话**才给只读提示，否则留空。

原来的写法是"渲染一行说明文字解释这里为什么是空的"。在整屏布局下，这些说明行是纯粹的视觉噪音
——空态已经由中间的品牌页说清楚了。**空态不解释，是这次改动的自洽选择。**

**检索从"横幅"改成"浮层"。** 会话内检索原先会占一整行把消息流推下去；现在
`.wb-search` 是 `position:absolute; top:40px; right:14px; z-index:25` 的浮层，
由 `.wb-top` 的 `⌕` 切换（`State.wb.searchOpen`）。过滤框同理默认收起（`treeFilterOpen`），
一进来先看到树本身而不是一排控件。

**默认落地：落进第一个工作区 + 右栏收起 + 未分组空桶不渲染。**
`wbEnsureLoaded` 首次加载时，若还没选中工作区且已有工作区，就落进第一个 ——
新装修的界面不该停在"未分组"上等用户去点。右栏 `railOpen` 默认 `false`，
与原生第一屏一致（要用上下文再点开）。未分组桶只在**真的有未分组会话**（或当前就停在未分组）时渲染，
否则左侧树底下永远挂着一条空桶。

**回归钉在哪（0.21.2 增量）**：

| 钉子 | 位置 |
|---|---|
| 落地页是品牌头 `wb-brand`、无 `.topbar` / 无 `.page-title`；`workbench` 页判据用 `id="wb-input"` | `tools/test-frontend.mjs` |
| 全屏工作台自带登出入口（`data-act="logout"` + 账号条 `wb-account`）—— 顶栏已不在，否则登出不可达 | 同上 |
| 输入卡结构：模型 / 等级 / 发送钮都在 `.wb-card-foot` 切片内，且 `id="wb-model"` **恰一个** | 同上 |
| 空态不渲染噪音条（KB 条 / 附件条 / 消息流） | 同上 |
| 过滤框、检索栏、右栏默认收起 —— 用例须先调 `wbToggleTreeFilter` / `wbToggleSearch` / `openWorkbenchRail()` | 同上 |
| 真机：≤1100px 右栏折到主区下方占满整行；**收起右栏是两轨 `200px`**（不是一轨）；≤820px 才是一轨；开合钮为**纯图标钮**、靠 `title` 表意 | `tools/test-browser.mjs`（S19） |

⚠️ S19 这条值得单独记一笔，与 §7.12.1 那条同源：把「显示上下文 / 隐藏上下文」的文字标签
换成图标钮之后，`br.textOf('[data-act="wbToggleRail"]')` 的断言**必然失败** ——
按钮文字现在恒为 `▤`。**状态改由 `#wb-rail` 在不在 DOM 里表达**，可读标签只剩 `title`。
同样地，"收起右栏=几轨"也跟着布局变了：≤1100px 收起是**两轨**（左栏 + 主区），
只有 ≤820px 才折成一轨 —— 照旧值（`180px` 起、一轨）写的断言会红得让人以为是布局坏了。
**判据跟着结构走，别跟着记忆走。**

---

#### 7.12.3 内核热切换：保存即生效（0.21.3）

**改掉的是本产品一句错误的自我限制。** 此前界面上写着"内核连接是进程级配置，保存后需要重启"，
代码里的理由是：

> 内核门面在装配期就被路由持有，热切换会让"正在跑的回合用的是哪个 provider"变得不可判定。

这句话一半是**事实**（门面确实被路由持有，`server.mjs` 还在启动时抓了一次 upgrade 处理器），
一半是**把当时的实现形状说成了不可逾越的约束**。拆开只有两条：

**① 门面形状（可改）。** `facade()` 原先是对象字面量，`mode` / `provider` / `reason` /
`dshStatus` / `contract` 全是**值属性**，所以"换内核"只能重来一遍全装配 —— 而路由表
持有的是**旧那个对象**。改成内部持 `state` + 对外全 getter + 一个 `swap(next)` 之后，
换内核 = 原子写一次 state：门面引用不变、`deps.kernel` 不用重接、
所有 `kernel.provider.xxx()` 调用点**下一行就拿到新值**。
（这正是"改成 getter"是这里唯一正确形状的原因：它让改动量等于**零**，而不是等于"调用点数"。）

**② 在途回合（真问题，但有确定答案）。** 一轮对话跨 `submitTurn` 与 `streamTurns`
两个 await 点。既然内核能中途换，就必须回答"正在跑的那一轮用哪个" —— 做法是
**在回合开头抓一次 provider 局部变量**（`routes/kernel.mjs` 的 `turnKernel`），整轮都用它：

| 时刻 | 用哪个内核 |
|---|---|
| 切换前已开始的回合 | **旧**内核，一路跑完 |
| 切换后新发起的回合 | **新**内核 |

于是语义变得**可判定**（正是原来那句"不可判定"的反面），"切内核不打断正在进行的对话"
也从一句愿望变成一条实现。被换下的 provider **不需要关闭** —— 上游客户端是纯 `fetch`
（无长驻连接）、会话日志是 `statSync` + 一次性读取（无打开的文件句柄），只是内存对象。

**③ 两处"看起来无关、其实换不掉"的绑定**，改的时候必须一起拆：

- `app/http/server.mjs` 的 WS 桥处理器在 `createServer` 时抓了一次 ⇒ 换内核之后，
  实时流仍从**已经不该再用**的那一个来。改成在 `upgrade` 事件里**现取**
  （`createWsBridge` 每次调用只返回一个纯 handler、仅捕获 client，现取无副作用）。
- `runTurn` 里的三处 `kernel.provider.*` ⇒ 见 ②。

**④ 那条"保护性判断"已经删掉了（0.21.4 / 0.21.5）。** 值得留下一段，因为它是一个
**保护措施活过了它保护的对象**的实例。

当年的规则是：`auto` + 探测失败属于"计划外降级"，此时**保留原内核不切** ——
免得运维填一个"内核稍后才启动"的地址，把此刻正好好跑着的外部内核换掉。
它保护的对象是**内置 mock 内核**：`auto` 探测失败会降级到它，而"降到 mock"意味着
界面显示正常、实际拿不到真实回答。

那个 mock 连同"内核模式"整个概念在 0.21.4 被删除（见 `app/kernel/unconfigured-provider.mjs`），
保护对象不存在了 —— 于是剩下的只有一句更简单的话：**保存什么就是什么。**
0.21.5 再把入口收紧（保存前必须检测通过）之后，"先存着一个连不上的地址"甚至无法被提出。

| 情形 | 会不会切 |
|---|---|
| 内核地址可达 | **切**，当场生效 |
| 目标不可用而仍然走到这一步（手改 config.json 后触发重新装配） | **照切**，并如实报 `ready:false` —— 不保留原内核 |
| 通过 HTTP 保存口提交一个探测不通过的地址 | **根本到不了这里**：保存口先探测，未通过直接 409 |

**⑤ 仍然要重启的两种情形，必须继续说重启。** 新能力不能顺手让旧的诚实消失：

- **环境变量覆盖**（`DSH_ORIGIN` 优先级最高）：文件改了、进程不变。
- **重新装配抛错**：如实报"已保存但切换失败，仍用原内核"。

> 拿一个新的谎言去替换旧的缺陷，比留着旧缺陷更糟。

**⑥ 与首次装配同构。** 切换走 `reloadKernel`，与启动装配**共用同一个 `gated()`**（能力闸
漏在任一路径上，都会出现"换完内核后被 deny 的 MCP 服务又回来了"这种只有切换过的进程才有的怪状态），
并且**重新 `loadConfig()` 读盘** —— 保存是直接写文件的，不重读就会"换了等于没换"。
令牌在**副本**上解密、成功后才回写内存：`unlockKernelToken` 在"已有令牌"时直接返回，
所以**必须先显式回落再解锁**，否则用户点"清空令牌"时，内存里会留着上一次解密出来的明文
（清空变成没清）。

**回归钉在哪（0.21.3 起，0.21.5 更新）**：

| 钉子 | 位置 |
|---|---|
| 保存可达地址 → `restartRequired:false`、`kernel.ready` **当场**变 `true`、`status.restart.pending` 变 `false`（旧行为里这句恒真，它必须**有能力变假**） | `tools/test-http.mjs` |
| 目标不可用而仍要切 → **照切**、`kernel.ready` 变 `false`（直接驱动装配层：0.21.5 删掉 `force` 后这条路径走不到 HTTP 口了） | 同上 |
| 检测没通过 → 保存口 409 且**带着完整诊断**；老客户端再传 `force` 也一样被拒（防那条旁路被人加回来） | 同上 |
| env 覆盖时仍报 `restartRequired:true`（不许因为"支持热切换了"就谎报已生效） | 同上 |
| 测试脚手架必须注入 `switchKernel` —— **缺了它，"保存即生效"这条路径会静默测不到**（接口如实降级成"需重启"，断言照样绿） | `tools/test-http.mjs` 装配段 |
| 弹框上「保存并启用」成功 → 弹框**当场关掉**并落到落地页；没检测过时保存被本地拦住、不发请求 | `tools/test-frontend.mjs` |

⚠️ 最后一条是本版最该记住的：**新增 deps 能力时，测试脚手架漏接不会报错，只会让断言测了个寂寞。**
所以新钉子写成"**观测门面本身**"（读 `kernel.ready` / `kernel.dshStatus`）而不是"读响应体" ——
响应体可能只是把请求里的配置回显了一遍，那正是假货 ① 的样子。

---

#### 7.12.4 内核接入界面的一次收敛（0.21.5）

**改掉的是"把说明书写进弹框"。** 未接入内核时的阻断页曾经有四五屏：内核是什么、
平台哪些功能不依赖它、为什么整页拦住、可核对项表格（地址 / HTTP / 服务 / 类型 / 版本 / 令牌）、
保存回执（写了哪个文件、多少字节）、切换语义的两条须知……

问题是这一页面对的人是**第一次把平台跑起来的管理员**：他手里已经拿着内核启动打印的那一行，
需要的是"粘哪儿、点哪个键"。四屏解释之后，真正要做的两件事被埋在中间。

于是收敛成**一屏**，并且顺手把两件"说不动人只好解释"的事改成**不用解释**：

| 从前靠解释的事 | 现在靠什么 |
|---|---|
| 保存后要不要重启（要写一段"保存即生效…只有 env 覆盖才需要重启"） | 保存成功**当场关闭**并进首页 —— 行为本身就是答复 |
| 为什么保存键是灰的（要写"没有跳过检测的口子…"） | 灰键旁边一句话：先点检测。而"跳过检测"这个选项本身已经删掉，不用解释它为什么不建议用 |

细节给**概览页**那张接入面板留着（`kernelProbeCard(p, compact)` / `kernelFormHtml(pfx, compact)`）：
那里的人是运维，正在排查一次接不通，可核对项对他有用。同一个组件两种形态，
判据是"这一屏上的人此刻要做什么"，而不是"哪个页面更高级"。

两条随之而来的收紧：

- **保存必须以检测通过为前提**（`force` 那条旁路删除）：它唯一的作用是把一条当场已被证伪的
  配置存进去，换到的是"保存成功、平台却没接入上"——那是最难自查的一种失败（界面显示"已保存"）。
  前端把保存键置灰是**把话说在前面**，服务端同样按这个前提拒（它会自己重探一次）。
- **改动输入即作废上一次的检测结论**：否则"先探一个好地址、再改成另一个"就能绕过上一条。
  作废时重绘一次并把焦点与光标放回原处（`resetKernelProbeOnEdit`）—— 这条路径每次输入都会走，
  丢焦点的手感比灰一个按钮糟得多。

#### 7.12.5 工作区权限整块删除、左栏结构收口、落脚会话（0.21.6）

##### 一、为什么把"工作区权限"整块删掉

0.21.0 给工作区配了三档访问权限，还配了 `open`/`restricted` 可见性与一份工作区级授权名单。
**0.21.6 整体删除**，触发点是用户的一句判断：

> dsh 原生有工作区权限三档；这块如果没有接口操作 dsh 原生工作区权限，这块的权限没有
> 什么意义 —— 这块设置了，原生的 dsh 又没办法改。

核对下来这是事实，而且是**结构性**的，不是一个可以绕开的实现细节：

- 上游自己有一份工作区权限三档。真实内核的 21 个契约方法里，与"权限"沾边的只有
  `listPendingApprovals` / `respondApproval` —— 那是**工具调用审批**，走事件流、事后可见，
  **不是 RPC**；契约快照里搜 permission / approval / sandbox / mode 全部无结果。
- 也就是说平台这份是**第二份真相**，而平台**没有任何接口去改上游那一份**。
  在平台上把人调成"完全权限"，上游那侧一动不动。

结论落在了这条判断上：**一份改了不生效的权限配置，比没有权限配置更糟。**
它让人以为已经管住了 —— 这比"明确不管"危险得多，因为它会改变人的行为（该谨慎的地方不谨慎），
而且不出错时没有任何迹象。于是选择整块删掉，等想清楚怎么与上游对齐再回来做。

##### 二、删了什么，以及删完之后谁在把门

| 层 | 删除物 |
|---|---|
| 数据 | `workspaces.visibility` 列（迁移 **`0023`**）；`role_bindings` 里 `scope_type='workspace'` 的绑定（**库级 `knowledge_base` 与租户级绑定不动**） |
| 判定 | `visibility.mjs` 里的 `WORKSPACE_VISIBILITIES` / `normalizeWorkspaceVisibility` / `decideWorkspaceAccess` / `visibleWorkspaces` / `maxLevel` / `ADMIN_ROLES` |
| 服务 | `service.mjs` 的 `listGrants` / `grant` / `revokeGrant` / `verdictFor`；`listTree` 不再过滤、不再下发 `myLevel` / `grantRoles` / `levelLabels` |
| 路由 | `GET/POST /api/workspaces/:id/grants`、`DELETE /api/workspaces/:id/grants/:bindingId`（路由 **146 → 143**） |
| 界面 | 7 个动作（`wbToggleGrants` / `wbSessionGrants` / `wbGrantAdd` / `wbGrantRevoke` / `wbWsVisibility` / `wbReloadGrants` / `wbGrantSubjectType`）+ 授权面板 + 档位徽片 + 输入卡上方的工作区下拉 |

**门禁没有消失，消失的是"这个工作区单独授权"这一层。** 三件事没动：

1. `levelFromRoles` 仍在，仍是档位的唯一来源（只是输入只剩组织角色）；
2. 路由层仍由 `session:read` / `session:write` / `session:execute` 把守；
3. `assertWorkspaceAccess` 的签名与语义几乎不变（工作区不存在 → 404，档位不够 → 403），
   内核路由那三处调用点**一个字没改** —— 变的只是它背后那条判据。

⚠️ 一处**语义确实变了**，必须记住：「**看不见的工作区 → 404**」这条消失了。
工作区现在对全组织可见，404 在这里只剩"真的没有这个 id"一种含义。回归里因此加了一条反向断言：
member 改工作区必须是 **403**，不能是 404。

##### 三、左栏结构收口（同一轮的用户要求）

| 从前 | 现在 | 为什么 |
|---|---|---|
| 左栏顶部「✦ 新会话」胶囊 | **删除** | 与工作区行的「＋」重复；且"建在哪儿"这件事只有一种正确答法 —— 在哪一行点就在哪儿建 |
| 左栏顶部「🧩 插件」 | **删除** | 插件是平台管理面的事，不是对话工作台的入口 |
| 工作区行尾的常驻徽片（会话数 / 我的档位） | 换成 **`⋯`（重命名 / 删除）在左、`＋`（新会话）在右** | 档位随权限模块删掉；两个动作**鼠标划过才现身**（CSS `:hover`），树的层级因此看得清 —— 树是靠名字读的，不是靠一排图标 |
| 工作区菜单五项 | **只剩两项** | 「＋ 新会话」提到行上（最高频的动作不该藏在二级菜单里）；「工作目录…」删掉（要改 cwd 就删了重建，会话会落回"未分组"而不丢）；「工作区权限…」随模块删除 |
| 未分组桶行尾 | **只有 `＋`** | 它没有可重命名/删除的东西，那个菜单里本来也只有"新建会话"一项 |
| 输入卡上方的工作区下拉 | **删除** | 它与左侧树是两个改同一件事（`wsActiveId`）的入口：在下拉里选 A、再从树上点 B，界面不告诉你哪个算数 |

⚠️ **一个 CSS 选择器陷阱**（改动时踩到、写下来免得下次再踩）：`.wb-menu-open > .wb-row-more`
是**子**选择器，而 `⋯` 现在包在 `.wb-row-ops` 里 —— 不同步改成**后代**选择器
（`.wb-menu-open .wb-row-more`），菜单一打开 `⋯` 就会跟着隐掉，用户看到的是"点开菜单后按钮消失了"。

##### 四、落脚会话：新装的平台不该是一棵空树

初始化时在默认工作区里放一条空会话。用户第一反应是"这东西坏了"，而不是"我要先建一个会话"；
放一条在那里，平台一进来就是个能用的样子。

⚠️ 它是**一条只在本地库里的会话**（`kernel_session_id` 为空），**刻意不在播种时调上游建会话**：
播种可能发生在内核接好之前（启动播种、初始化向导），而 0.21.4 起未接入内核时上游直接拒答 ——
硬要去建，得到的是一条"**看起来建成了、其实没有上游会话**"的假记录，那正是本项目一直在删的东西。

约定因此是：**本地会话行是平台侧的身份，上游会话按需建立。**
用户第一次真的要用它时（发消息 / 拉事件 / 挂库…），内核路由的 `requireSession`
当场补建上游会话并把 id 写回。
> 从前这里直接 409「该会话没有关联的内核会话」，用户看到的是一条**能打开却发不出消息**的会话 ——
> 那是个死胡同，而且解释不出来（"我明明建好了"）。

**幂等判据是"全平台零会话"，不是"这个工作区零会话"。** 后者会让每一个被用户清空过的
工作区在**每次启动**时都重新长出一条会话 —— 那是往人家的地里反复塞东西。
零会话才是"从没被用过"的唯一诚实判据，也只覆盖"新装的 / 从没真正用过的"平台。

实现上有一处要留意：`sessions.touchSession` 的可写列加入了 `kernel_session_id`。
这是安全的，因为写入点只有补建分支，且**只在原本为空时才跑** —— 不会造成"中途换上游会话"。

##### 五、迁移纪律与一条测试自洽教训

- **迁移 `0021` 一个字都不能改**（`migrate.mjs` 会做 sha256 比对）。删列只能新增迁移，
  所以 `visibility` 的删除落在 **`0023_drop_workspace_permission.sql`** 里，头注释写了理由与
  不可逆影响（受影响的 restricted 工作区会对所有成员可见）。
- **测试不许依赖本机环境状态。** `test-core` 的 §B10 断言"自检第 [14] 项配齐后是 `ok`"，
  而那一项会去读**环境**里的备份密钥（`STI_BACKUP_KEY` → `data/backup.key` → 都没有则 `warn`）。
  于是这条用例的结论随"本机 `data/backup.key` 在不在"漂移：没清过库的机器上绿、
  把库重置成"刚解压"的机器上红 —— 一条**假红**。修法是让用例自己钉住那个输入（显式设 env 并还原），
  **不是**去放宽断言。判据：用例的结论不该由环境决定。

##### 六、这一轮删除的回归钉法

删除最容易做成"藏起来"（CSS 一盖、条件一判，代码还留着），而藏起来的那份会一直在。
所以钉子成对出现，且**对渲染结果与 App 动作表双向断言**：

| 钉子 | 位置 |
|---|---|
| 迁移 `0023` 生效：`workspaces` 已**没有** `visibility` 列（而不是"默认值对不对"） | `tools/test-core.mjs` |
| 路由表：工作区恰好 4 条（**0.21.7 起 5 条 —— 多了目录列举 `workspace.browse`**），且 `workspace.grants.*` **不许回来** | `tools/test-http.mjs` |
| 树不再下发 `levelLabels` / `grantRoles` / `myLevel`；授权端点对**管理员**也 404 | 同上 |
| 8 个已删动作：`typeof App[x] === 'undefined'` **且**渲染结果里没有对应 `data-act` | `tools/test-frontend.mjs` |
| 两个菜单里不许出现"权限"字样；前端一次都不请求工作区授权名单 | 同上 |
| 左栏顶部两个入口已删（`wb-new-chat` / `🧩` 都不在）；输入卡上方没有 `#wb-ws` | 同上 |
| 行尾 `⋯` 与 `＋` **恒在 DOM 里**（显隐是 CSS 的事）、顺序是 ⋯ 左 ＋ 右、菜单恰好 2 个按钮 | 同上 |

---

#### 7.12.6 界面收口：一套图标、一个展开入口、一个绑定项、一条轴（0.21.7）

这一版没有新概念，全部是**把已有的东西对齐**：三处是修错，一处是删，两处是把"两个东西"
并成一个。按用户的原始描述逐条落地。

##### 一、图标：一套内联 SVG，换掉全部散装 Unicode 字形

用户的原话是"图标都再换一下**有大有小难看**"。核对下来根因有三层，第三层是真的坏了：

1. **大小不一的来源是字体。** 此前的"图标"是一个个 Unicode 散字：
   `⇤ ⌕ ⟳ ＋ ⋯ ▾ ▸ 📁 ▦ ⚙ ▤ ⊕ ↑ ⌫`。它们出自不同的字体块（箭头 / 数学符号 / 装饰符 /
   表情符号），**基线与字宽各异** —— 同一个 `font-size` 排出来就是有高有低、有大有小。
2. **语义靠猜**：`▤` 是"上下文面板"、`⊕` 是"附件"…… 只有作者知道。
3. **`⌗`（U+2317）在 Windows 的中文字体里没有字形**，真机渲染成豆腐块（`□`）。
   这不是"难看"，是**没渲染** —— 0.21.2 的真机层抓到过一次。

改法：一套 **17 个键的内联 SVG**（`WB_ICONS` + `wbIcon(name, cls, title)`，`84-workbench.js`）。
同一个 16×16 视口、同一线宽 `1.5`、`stroke="currentColor"`（跟着文字取色，主题翻转自动跟随），
尺寸只由 CSS 的 `.wb-ico` / `.wb-ico.sm` 定。四条判据：

- **零资源文件**：内联 SVG 是 document 的一部分，不发额外请求，也不受 CSP `img-src` 影响；
  （`select` 的下拉箭头用的是 CSS `data:` URI，同一条思路。）
- **尺寸单点**：`.wb-ico { width:16px; height:16px; flex:0 0 auto }`，行内小号只改 14px，
  **不再有任何按字号变化的东西**。
- **可访问性**：`aria-hidden="true" focusable="false"` —— 图标是装饰，名字由按钮的
  `aria-label` / `title` 提供，不被读屏重复念一遍。
- **表情符号也不再用**：`📁` / `🧩` 这类 emoji 是**彩色位图**，字号一变大小就跟着变、
  各平台画风还不同 —— 与第 1 条是同一类病。全部换成 `folder` / `grid` / `gear` 等 SVG。

##### 二、左栏收起之后再也展不开：一个真 bug

修的是一个**真缺陷**，不是审美问题。机理一行为：

```css
.wb.side-closed .wb-side { display: none; }   /* 整栏藏掉 */
```

而**收起钮就住在 `.wb-side` 里面**（品牌头右侧）—— 于是收起之后，那颗钮跟着一起被藏掉，
**界面上再也没有可达的展开入口**，只能刷新页面。

修法不是"换个选择器藏"，而是认清**入口与它操作的容器不能住在同一个被隐藏的子树里**：
展开钮渲染在 `.wb-side` **之外**（`.wb-main` 里，绝对定位在主区左上 `left:10px; top:8px`），
只在 `sideOpen === false` 时出现。两颗钮调**同一个**动作 `wbToggleSide` ——
一个状态、两个方向、两个出现条件互斥的入口。

回归钉的不是"有按钮"，而是**结构**：`<aside class="wb-side">…</aside>` 这一段里
**不许**出现 `wb-side-expand`。钉"有按钮"是不够的 —— 按钮住在栏里时它也"有"。

##### 三、「模型未归因」到底是个什么：应当把它变成一件事

用户问："模型未归因又是个什么，右边不是有模型选择和推理等级吗（右侧选择哪个模型会话就绑定
哪个模型不行吗）"。答案是：**他说得对，那个徽标在解释一个不该存在的问题。**

归因的真实链路是 `agent_sessions.model_id`（`kernel.mjs` 的 `runTurn` 用它算用量）——
发回合的请求体里**根本不带模型**（只有 `content` + `attachmentIds`）。所以"选择器显示什么"
与"会话绑了什么"一旦不一致，**用户看到的模型就不是真正在用的那个**。徽标想说的正是这件事，
但它给不出任何出路，只能反复提示"你还没归因"。

正确的修法不是再补一个"归因状态"的**第三概念**，而是把两者**并成一个**：

1. 新建会话时选择器的值随请求体提交（`wbNewSession` 的 `body.model`）；
2. 打开已有会话时若服务端没记、本地有值，就地**补绑**一次（`wbRefreshContext` 里的
   `POST …/model`）；**静默失败**是有意的 —— 只有 `session:read` 的角色会在这里 403，
   那不是错误状态，是"这个账号本来就没有登记模型的权限"，弹红条只会是噪音；
3. 选择模型时立即登记（`wbSelectModel`）并如实播报后果。

补完之后 `选中的 ≡ 绑定的`，徽标无事可报 → **删除徽标**。
`modelRecorded` / `modelRecordedProvider` 两个状态仍在用（下拉回显要按它选中），
成本报告里的"未归因"桶也照常存在 —— **那是账本的事实，不该被界面回避**。

##### 四、会话内检索与清屏：整块删除

用户裁定"右上角（会话内搜索删除、清屏删除，只保留上下文面板）"，追问后选**整块删除**。
删除面（一并清掉，不留"藏起来的那份"）：

| 层 | 删掉的东西 |
|---|---|
| 路由 | `kernel.sessions.search`（`GET /api/kernel/sessions/:id/search`） |
| 仓储 | `events.searchEvents` |
| 前端动作 | `wbRunSearch` / `wbJumpToHit` / `wbClearSearch` / `wbToggleSearch` / `wbReset` |
| 渲染 | `wbSearchPanelHtml`、命中高亮（`wbStreamHtml` 里的 `.hit` 标记）、`.wb-search*` / `.wb-hit*` 样式 |
| 状态 | `State.wb` 的 `searchQ` / `searchBusy` / `searchResult` / `searchError` / `searchOpen` |
| 监听 | `90-start.js` 里 `#wb-q` 的回车即搜 |
| 测试 | 前端两条检索用例 + 前端录制与桩、HTTP 一条检索用例、跨租户那条的检索入口（换成**事件列表**，隔离覆盖面不丢） |

⚠️ **那本来是一套正确的设计**，代码注释里留了它当时的口径（服务端搜而非前端过滤、
按"可见文本"复核掉只命中结构化字段的假阳性、`LIKE` 通配符转义、归属校验走
`sessions.getSession`），万一要加回来照做。

##### 五、右栏两块展示：`实际调用` / `可用能力` 删除，事实不丢

用户裁定删掉这两块。删的是**展示**，不是事实，也不是数据通路：

- 当时保留的"对账口径 + 工具卡来源徽标 + `wbAttributeTool` / `wbCatalog` /
  `w.caps` / `w.capsMcp` 拉取"**在 0.21.10 全部删除了** —— 用户接着裁定工具不是可登记的能力
  （没有清单、没有开关、内核自己调用），对账的另一端不存在了。详见 §7.11 的重写。
- ⚠️ 这一条留下的教训：**0.21.7 说"保留是因为徽标还在用"，而 0.21.10 连徽标一起删了。**
  "某函数还有人用"是一个**当时**的判断，不是永久理由 —— 引用它时必须带上"因为 X 在用"，
  否则下一个版本删掉 X 之后，没人知道那个函数已经悬空了。
- 仍然成立的是：**工具卡本身没动过**（0.21.7 与 0.21.10 两次都没删它）。
  它是会话事实，不是治理对象。回归里保留了"逐个工具卡各取一个 head"的验法
  （原版只取第一个，工具一多就漏），并新加了一条反向断言：卡上不该再有来源徽标。
- 另加两条**反向断言**：右栏不再有 `<h2>可用能力</h2>`、不再有 `.wb-call` 行。

##### 六、新建工作区：cwd 从"盲填"改成"看得见地选"

`cwd` 是**服务器上**的路径，决定上游项目级能力能读写哪一片文件系统。此前是让用户**手打**，
两个必然结局：打错（路径不存在），或打对但根本不知道那是什么目录。
浏览器也给不了服务器目录树 —— `<input webkitdirectory>` 拿到的是**客户端**的目录，
而且在浏览器里只能得到 `C:\fakepath\…` 这种假路径，存下去就是一个服务器上不存在的位置。

于是新增一个**只读**的服务端接口 `GET /api/workspaces/browse`（`platform/workspace/browse.mjs`）：

- **它不增加任何能力。** 判据：`workspace.create`（`session:write`）本来就接受**任意** cwd
  字符串 —— 能建工作区的人早就能把 cwd 指到服务器上任何一处。所以本接口挂**同一个门**，
  只把"盲填"变成"看得见地选"。
- **边界**：只列目录不列文件；路径先 `realpathSync` 归一（解析 `..` 与符号链接）；
  不递归（因此没有符号链接成环导致遍历失控的问题）；`MAX_ENTRIES=500` 上限并如实标 `truncated`；
  读不了报 **400**（带 errno）、不存在报 **404** —— 与库级 ACL 的 403/404 分离同一条纪律。
- ⚠️ **`ENOTDIR` 两处抛、归同一个码**：`realpathSync` 与 `readdirSync` 都会抛它
  （`xxx/VERSION/..` 走前者、`xxx/VERSION` 走后者），两处给不同的状态码是最难查的一类不一致。

界面侧是 `Dlg.browse`（`15-dialog.js`）——目录选择器同样是**状态**（`State.dlg`），
所以能被 vm 层回归直接驱动。交互刻意只有"点进去 / 退出去"两种，**不做路径输入框**
（手打路径正是这一版要消掉的东西）。返回值是**三态**，调用方必须分清：

```
目录路径  → 用它
''        → 用户选了「不设工作目录」（一个有效的选择）
null      → 取消，整件事别做
```

**判"取消"只能用 `=== null`** —— 写成 `if (!v)` 会把"不设工作目录"当成取消，静默什么都不做。
另有一处拦阻：`browsePath` 还空着就点「确定」，返回的会是空串、被上游当成"没给 cwd"，
于是**静默建出一个没有工作目录的工作区** —— 所以必须在弹层里拦住并说清，不关窗、不发请求。

> **⚠️ 0.21.9 起，上面那段取值的中态已删除**（用户裁定：「新建工作区弹框，去掉最下面的
> 不设置工作目录」）。现在的契约是**两态**：`路径（保证非空）` / `null`。
>
> 理由不是"少一个按钮"，而是那个中态**说不清自己是什么**：这个框叫「新建*工作区*」，
> 而 `cwd` 是工作区唯一有实质影响的属性 —— 一个不绑任何目录的"工作区"没有定义；
> 它还让取值多出一个**只在建完之后才显形**的分支（空串 vs 路径）。
>
> ⚠️ **能力没减，减的是出口**：`workspace.create` 照旧接受空 cwd（API 与数据层一字未动），
> 这一版之前建出来的空 cwd 工作区也照旧显示、照旧能用。所以：
> ① 弹框那一侧 `submit()` 的拦阻从"两态之一"变成**唯一的**一道校验；
> ② `wbNewWorkspace` 仍**另加**一道同向拦阻（空路径只可能是"弹框出了问题"，就地报错、
>    绝不发请求）—— 两道都在，一道负责"说清为什么"，一道负责"万一漏了也别建出坏数据"。
>
> 同一条裁定还删掉了常用起点里的**平台数据目录**与**平台安装目录**（`browse.mjs`
> 的 `browseRoots()`）。判据是"别把人往那儿引"：那两个是**平台自己的家**（数据库、日志、
> 密钥、源码），恰好是所有目录里最不该当工作区的两个 —— 摆成"常用"等于一个诱导，
> 选中之后上游项目级能力就能在平台自己身上读写。同样地，它们没有被"禁掉"，只是不再推荐；
> 回归因此钉的是**反向**（起点里 `includes(DATA_DIR)` / `includes(ROOT)` 必须为假）。

##### 七、宽度与居中：上下两截要落在同一条轴上

用户说"下面的对话框宽度是不是太窄啦，上面的对话内容是不是两边容距太小也没有居中"。
核对下来是**两个不同的问题**：

1. **太窄**：`--wb-compose-w` 是 `min(780px, calc(100% - 48px))` → 放宽到 **900px**。
2. **不居中 / 上下不在一条轴上**：消息流此前**横跨整个主区**（`padding: 52px 24px`，没有内层收窄），
   而输入卡居中收在 780px —— 一眼看去两截不在同一条轴上。修法是给消息流套一层
   `.wb-stream-inner { max-width: var(--wb-compose-w); margin: 0 auto }`，**与输入卡同一个变量**。

⚠️ 这里有一个**自定义属性的陷阱**，值得单独记一笔：原来把 `calc(100%)` 写进了
`--wb-compose-w`。**`100%` 是在"使用它的那个元素"上解析的**，而 `.wb-compose-wrap`
（`.wb-main` 的子元素）与 `.wb-stream-inner`（`.wb-stream` 的子元素，而 stream 自己带
左右内边距）会解析出**两个不同的值** —— 于是"同宽"在同一次渲染里根本不成立。
所以这个变量改成**纯长度**，两侧留白交给各容器自己的 `max-width: calc(100% - 48px)`。

⚠️ 还有一条**最容易被忽略的必要条件**：消息流是**滚动容器**，而输入卡不是 ——
一旦内容超出高度，滚动条就会吃掉内容盒右侧的宽度，`margin: 0 auto` 居中的 `.wb-stream-inner`
于是整体左移**半个滚动条宽**（本项目滚动条 8px → 偏 4px）。这条特别阴：**短对话里看不见
（没有滚动条）、长对话里必然出现**，而且它只在"有滚动条"和"没滚动条"两种状态之间跳，
看起来像"有时候对齐有时候不对齐"。修法是 `.wb-stream` 加 `scrollbar-gutter: stable both-edges`
—— 两侧预留同样宽度的沟槽，内容盒相对**内边距盒**恒对称，**不依赖滚动条当前是否出现、也不依赖
它有多宽**（真机验收里量到的是 `左 Δ0 右 Δ0`，而同一份现场快照显示消息流**确实处于可滚状态**）。

⚠️ 还有一条不变式不能破：`.wb-stream-inner` **只在有内容时才渲染**
（`streamBody ? '…' : ''`）。`.wb-main.is-empty .wb-stream:empty { display:none }` 这条
"空态不占位"的规则，靠的正是 `.wb-stream` **自身为空** —— 无条件套一层内层容器，
它就永远不为空，空态会白占一块高度。回归里有正反两条钉子，真机层再加一条：**量出来的对齐
必须是"有内容"时量的**（所以那一条场景会先把会话打开，并且如实打印"消息流可滚=true"）。

##### 八、其余两处收口（同一轮用户描述）

- **工作区节头那一行**：① 过滤钮与新建钮改成**划过这一行才现身**；②「重新拉取工作区与会话列表」
  这个入口**整个删掉**（树在切会话、建/删/改之后都会自己重拉，"手动刷新"是个多余且容易误判的
  入口 —— 点了没变化时用户会以为"坏了"；`wbEnsureLoaded` 本身仍被那些路径调用，删的只是按钮）。

   ⚠️ "划过才现身"用的是 **`opacity`**，**不是** `display:none` / `visibility:hidden`：
  后两者会让按钮**从 Tab 序列里消失**，键盘用户就再也够不到"新建工作区"。所以配一条
  `.wb-sec-head:focus-within .wb-sec-tools { opacity: 1 }` —— Tab 进来立刻显形。
  回归读样式表把这条纪律钉住（vm 层没有真实布局与焦点）。

- **两个 tab 的常驻性**：过滤钮与新建钮**恒在 DOM 里**（显隐交给 CSS，不是条件渲染）。
  这一点必须钉住：真机层只能靠 hover 让它们现身，DOM 里没有就等于功能没做。

##### 九、这一版的回归钉法

| 钉子 | 位置 |
|---|---|
| 目录列举：只列目录（正面验证每个 entry 都真是目录）、`..` 被 realpath 归一、不存在/非目录 404、viewer 403、未登录 401、声明面 `method/scope/capability` 逐字段 | `tools/test-http.mjs` |
| 工作区路由 **5 条**且 `workspace.browse` 的 `milestone = 0.21.7` | 同上 |
| 跨租户隔离：附件列表 / 下载 / **事件列表** 一律 404（检索那条换成事件，覆盖面不丢） | 同上 |
| 左栏收起后展开钮**不在** `<aside class="wb-side">` 里；两颗钮调同一动作；展开后展开钮消失 | `tools/test-frontend.mjs` |
| 节头两钮恒在 DOM；`.wb-sec-tools` 用 `opacity:0` 且**不许** `display:none`；有 `:focus-within` 与 `:hover` 两条显形规则；`data-act="wbEnsureLoaded"` 不出现 | 同上 |
| `.wb-stream-inner` 存在且 `max-width: var(--wb-compose-w)`；该变量是**纯长度**且 > 780px；**空态下 `.wb-stream` 里一个子节点都没有** | 同上 |
| 目录选择器三态：空串 → 照样建（`cwd: ''`）、取消 → 一个请求都不发、路径没读出来就点确定 → 拦住且不关窗 | 同上 |
| 工具卡本身仍逐条渲染（逐个卡各取 head；两张卡不多不少）＋ **卡上不该再有来源徽标**（反向）＋ 右栏两块展示的反向断言 | `tools/test-frontend.mjs` |
| 工作台**不再**拉 `GET /api/capability/skills`（来源徽标已删，那次请求在 0.21.10 失去唯一读者） | 同上 |
| 选中 ≡ 绑定的：会话有模型 → 选择器 `selected` 在它上面；界面里不再有「未归因 / 已归因」字样；没绑时**补登一次**、补登失败静默 | 同上 |
| 工作台里不再出现 `📁` / `⚙` / `⌕` / `▤` 等散装字形 | 同上 |
| 清屏与检索的**反向断言**：`data-act="wbReset"` / `wbRunSearch` / `#wb-q` / `.wb-search` 都不出现 | 同上 |
| **真机** S22（1600×900）：收起左栏后展开钮**不在** `.wb-side` 子树里、有可见尺寸、落在视口内，且用 CDP `Input.dispatchMouseEvent` 发**真实鼠标**点得开 | `tools/test-browser.mjs` |
| **真机** S22：节头两钮默认 `opacity:'0'` 且 `display` 不是 `none`；真实指针移上去 → `'1'`、移开 → `'0'`；聚焦「新建工作区」→ `:focus-within` 让 `opacity` 到 `'1'`（键盘用户不摸黑） | 同上 |
| **真机** S22：`.wb-stream-inner` 与 `.wb-compose-wrap` 的 `左 Δ / 右 Δ / 宽 Δ` 全 ≤ 1px、两者都 > 780px、正文列在主区两侧留白相等且 ≥ 24px；并**如实打印**"消息流可滚"（对齐必须在**可滚**状态下成立，否则测不到滚动条那一条） | 同上 |

---

#### 7.13 自定义角色授权：只落了表结构，判定层还没接（0.20.0 起的待收口项）

迁移 **`0020_custom_roles.sql`** 建了一张 `role_grants`：一行 = 一个
`(role_id, resource, action)` 授予（主键三列联合、`idx_role_grants_role` 索引），
头注释写清了设计意图 —— 不存 grants JSON blob（逐行可断言唯一、可按角色索引、逐条审计/回显直接）、
与 `roles` **同生共死**（仓储层删角色时**显式**先删本表行，不用 `ON DELETE CASCADE`，
与全库"外键默认 RESTRICT、删除步骤固定可数"的纪律一致）、可授予什么由 `permissions.mjs` 的
`CUSTOM_GRANTABLE` 纯函数把守（不给任何 delete、治理面写权不下放）。

⚠️ **但这张表当前没有任何消费方。** 全仓库（`app/` / `public/` / `tools/`）搜 `role_grants`
**只命中迁移文件本身**；`CUSTOM_GRANTABLE` 也只存在于那段注释里。判定链路的现状是：

| 层 | 现状 |
|---|---|
| 角色定义 | `permissions.mjs` 的 `ROLE_MATRIX` **硬编码四个内置角色**（`owner` / `admin` / `member` / `viewer`） |
| 判定入口 | `can(roles, resource, action)` → `effectiveActions()` → **只查 `ROLE_MATRIX`**；未知角色返回 `null` → 跳过（**不默认允许**） |
| 接口 | 身份模块只有 `GET /api/identity/roles`（列内置角色 + 矩阵），**没有"建自定义角色"的路由**，也没有角色级授权端点 |
| 表 | `role_grants` 建了、索引建了、**零读写** |

所以现在的诚实说法是：**建不了自定义角色，也授不了它的具体权限**，只能按内置角色分配。
这条列为**待收口项**，`docs/deploy.md` §10「还不能做什么」里有面向使用者的同一句。

> ⚠️ 它和 §7.12.5「工作区权限整块删除」是**两类不同的问题**，不要混：
> 那里删掉的是**与上游冲突的第二份真相**（平台改不了上游那份，留着只会让人以为管住了）；
> 这里是**平台自己的治理面**（页面与接口的 RBAC，上游不认这些资源）从未接通 ——
> 它该被**补上**，而不是删掉。

---

## 8. 数据层驱动抽象（应对 `node:sqlite` 的 experimental 状态）

`node:sqlite` 目前仍标记为 experimental。风险缓解：

1. **驱动接口收口**：`app/data/db.mjs` 只对外暴露 4 个原语——`exec(sql)`、`all(sql, params)`、`get(sql, params)`、`run(sql, params)`。
   业务代码**不得**直接 `require('node:sqlite')`。
2. **SQL 限定稳定子集**：只用普通表、FTS5、json1、BLOB、WAL；不用任何近期新增的实验性 API。
3. **升级窗口**：Node 版本在 `check.cmd` 自检里强校验（≥ 22.13），并在启动器里用 `--no-warnings=ExperimentalWarning` 收敛噪声。
4. **可替换性**：若将来必须换驱动（如 `better-sqlite3`），只需实现同 4 个原语，业务层零改动。
   这也定义了本项目**唯一允许破例引入第三方依赖的位置与前提**。
5. **降级路径**：若某环境确实无法启用 `node:sqlite`，`db.mjs` 可退回 JSON 文件仓储实现
   （能力受限：无 FTS5、无并发），自检里明确标注当前处于降级模式。
   ⚠️ **注意降级的真实后果**：本项目对 FTS5、BLOB 向量、json1 依赖较深，
   降级后**知识库功能整体不可用**（不是「能力受限」这么轻）。
   自检必须把「降级」与「知识库不可用」**明确区分**并告警，不能含糊。
6. **第二个破例位：中文分词**。bigram 预处理（§6.3）是零依赖可行方案，但质量上限低于专业分词。
   若目标客户对中文召回质量要求高，预留**可选接入外部分词服务（HTTP）或 WASM 分词库**，
   探测不到时回退 bigram 并**如实标注当前分词方案**。这是本项目第二个允许破例的位置。

---

## 9. 规模边界（诚实的能力上限）

单进程 + 零依赖是有代价的。明确写清边界，避免过度承诺：

| 维度 | 当前设计上限 | 超出后的路径 |
|---|---|---|
| 知识库向量检索 | **暴力余弦**，建议 ≤ 10 万 chunk（单次查询在 Worker 内并行分片） | ① **向量预过滤**（已实装、**默认关**）：用文本命中缩候选再算余弦 —— 延迟明显改善，但**会改变最终答案**，代价的实测见 `benchmark.md` §9；② 引入 ANN 索引；装配点 `retrievers/index.mjs` 已预留 `VectorIndex` 抽象（`createVectorIndex()`，换实现不改 service 调用方） |
| 文档解析 | 纯 Node 可处理的格式（md / txt / csv / json / html）开箱即用 | PDF / DOCX / XLSX / PPTX 走**可选外部命令**（`pdftotext` / `libreoffice --headless`），探测不到时**明确降级并告知**，不假装成功 |
| 并发 | 单进程事件循环；CPU 密集任务（分块、向量化）全部丢给 `worker_threads`。**实测量级与口径见 [`benchmark-concurrency.md`](benchmark-concurrency.md)**（闭环阶梯 / 开环定速 / 30 分钟长稳三种压法，但都是**同一台笔记本**上的数字） | 多实例 + 共享数据库（SQLite 不适合，需换驱动）；并发配额是**进程内存**，多实例必须重做 |
| 通知产生方 | 4 类事件**全部有产生方**（0.13.0 起）；其中 `quota.blocked` **会成串发生**，故带 **10 分钟合并窗口**（键 = 租户 + 事件 + 分键），避免刷屏 | 窗口是**进程内存**（单进程部署），重启即重新计时；跨机去重不适用 |
| 多租户 | 逻辑隔离（所有表带 `tenant_id`，仓储层强制注入过滤） | 物理隔离（每租户一个数据库文件）—— `db.mjs` 已按 tenant 分库预留 |
| 存储 | 本机文件系统 | 对象存储适配器 |
| 定时任务 | **单进程即单调度者**；进程不跑任务就不跑，且**不补跑错过的**（无 cron、无时区/DST、无分布式锁） | 多实例必须重做（需要租约表选主），**不是加一个开关** |
| 出站通知 | 失败投递**落库重投**（0.11.1 起）：单次最多 2 次内联尝试 → 失败入 `notify_deliveries` → `notify.retry` 指数退避重投（最多 6 次，超限转 `dead` 但保留可见可手动重投）。⚠️ **本机单进程**重投（无分布式锁）→ 平台**整体停机期间**的告警仍会丢；语义是 **at-least-once** | 跨机/多实例可靠投递需接消息队列（引入外部依赖，与 §10.2 冲突） |
| 指标 | 进程级内存计数器，**重启归零**；单进程内才有意义 | 接 Prometheus 远程写 / 多实例需外部时序库 |
| 成本核算 | **估算**，依赖人工登记的单价；归因靠"会话上登记的模型名"字符串匹配，匹配不到就进 `unattributed`（不摊派） | 精确计费需要挂在模型调用路径上的 gateway（尚未排期）；单价快照需要另建价格历史表 |
| 前端 XSS 防线 | `script-src 'self'`（**无 `unsafe-inline`**）：内联脚本/事件属性这条路已堵死 | 内联**样式属性**仍在（`style-src` 保留 `unsafe-inline`，130 处，见 §7.6）；`style-src` 收紧需先把内联样式迁到 class |
| 会话附件 | 单文件 ≤ 8MB；**图片**按**魔数**识别后作为内容块送给模型（本轮合计 ≤ 10MB）；**文本**注入本轮上下文 ≤ 96KB（单文件 ≤ 64KB）；其余二进制只登记/可下载 | 通用文件要送给模型需上游的**只读保存路径**通路（`fileUploads/upload`，B 档，**尚未接通**）；大文件应走知识库导入而不是对话附件 |
| ~~会话内检索~~ | **0.21.7 已整块删除**（用户裁定）。此前是事件载荷上的**子串**匹配（LIKE，通配符已转义）+ 可见文本复核，单次最多 200 条命中；实现里那两条纪律（通配符转义、`events` 表无 `tenant_id` 故须先证归属）留在了 `events.mjs` 的注释里 | 若将来要回来，按 `seq` 顺序扫长会话的代价仍在，需 FTS（与知识库同款 `bigram` 方案可复用） |
| 停止 | `cancelTurn` 是**通知**不是强制：平台能保证"不再接收"，但无法保证上游立刻停手 | 上游若忽略取消，只能靠用量页的数字发现；已在页面写明 |

> **原则**：任何降级都必须在自检与页面上**明确显示**。这延续「诚实数据源」原则。

---

## 10. 明确不做的事

写下来是为了避免范围蔓延：

1. **不做多容器编排。** 单机单进程优先；横向扩展只预留接口，不实现。
   > 注：**「单容器（Docker）交付」不等于「多容器编排」**——把单进程装进一个容器仍符合本原则。
   > 是否提供官方 `Dockerfile`：**已决策暂不提供**（2026-10-01），维持「解压 → 双击」。见 `docs/feasibility.md` §8 决策点 5。
2. **不引入 Python / Vue / MongoDB / Redis / Weaviate。** 用 Node 内置能力等价实现。
3. **不 fork 或 patch DSH 源码。**
4. **不做浏览器 Agent / Code Agent 的本地执行能力。** 那需要本地会话与终端（同类方案通常把它放在独立桌面客户端）；本项目聚焦 Web 生产平台。
5. **不做计费与商业套餐。**
6. **不为了好看而造数据。** 取不到就是空态。
7. **不做分布式锁 / 选主，也不做"替业务猜"的自动化。** 前者是"多实例"的直接后果（与第 1 条同源：
   单进程是**架构承诺**，不是当下省事的选择）；后者指"补跑错过的任务"这类 ——
   补跑一次归档与补跑一次备份的风险完全不同，让调度器统一猜是错的。
   宁可把边界写进页面（「进程停了就没有调度」「停机期间的告警会丢」），也不假装已经兜住。
   ⚠️ **0.11.1 起本条的"通知"那一半被修订**：失败投递**有了**持久化重投队列（`notify_deliveries`）。
   当初"重试几轮是在猜"这条理由，被一个**更坏的后果**盖过了 —— 上游抖一下就等于**告警永久丢失**
   （丢的还是 `audit.anchor` / `backup.failed` 这类必须被看见的事件）。
   修订后的形态**不是**"无限猜"：**有上限（6 次）、有退避、超限转 `dead` 且保留可见可手动重投**，
   并且把"还欠着几条"做成**页面上可见的数**（静默重投才是真正的猜）。
   但这一层**仍不做跨机协调**：队列由**本机单进程**的调度器驱动（无分布式锁），
   平台**整体停机期间**的告警照旧会丢。详见 `roadmap.md` 的「P1-2 补丁 · 通知失败重投队列」。
8. **不把内联 `style="..."`（当前 130 处）迁到 class（本轮）。** `script-src` 已收到 `'self'`（§7.6），
   但 `style-src` 仍留着 `unsafe-inline`。原因不是"忘了"，而是**收益与风险不对称**：
   内联样式能造成的危害（样式注入、布局破坏）与内联脚本不在一个量级，而上百处改写会大面积触碰
   渲染逻辑、回归面很大。因此**明确保留并写明**，而不是假装已经去干净。
9. **不做前端框架化 / 构建步骤。** 保持"零构建、直接打开即可读"：0.11.2 起前端**按域分成多片**
   `public/app/*.js`（§7.8），但**仍是经典脚本顺序加载**，不引入打包器、不引入 ES module 工具链。
   本项目要的是**可审计**（一次 `node --check` + 一个 `vm` 就能把前端真跑起来做回归），
   而不是开发体验上的便利。代价是手写 DOM 字符串拼接 —— 由 `esc()` 与事件委托兜住安全性。
10. **不做 multipart 上传解析。** 附件的传输契约是"**元数据走 query，body 就是文件本身**"。
    手写一个"差不多能用"的 multipart 解析器，出错方式是**静默地把文件截断或错位** ——
    比"不支持标准表单上传"糟得多。前端一行 `fetch(url, {body: file})` 即可，代价只是不能用
    `<form enctype="multipart/form-data">` 直接提交。
11. **既不装"图片没送给模型"，也不装"文件已送给模型"。**
    - **图片**（PNG / JPEG / WebP / GIF，按**魔数**识别）**确实作为内容块送给了模型**（0.10.0）——
      页面上就这么说，既不缩小也不夸大；
    - **其余二进制**（PDF / ZIP / DOCX…）**只登记、展示、可下载**，页面上**明确标注"不提交"**，
      并在响应里 `attachments.skipped[]` 逐条点名。**2026-10-02 已对着运行中的上游实测**：
      写入通道 `fileUploads/upload` 可用，但它只返回内容寻址的 `FileAttachmentRef`
      （**无路径**），而 wire 的 `session/prompt` **不收 `{type:'file'}` 块**、只读侧 20 个候选方法全 404
      —— 即"给模型一行只读路径"这条通路**不对外部 wire 调用方开放**（它是上游 host 侧内部投影的能力）。
      **在接通之前不谎报"文件已交给模型"**；⚠️ 也要**如实区分**："该能力不在 wire 契约上"
      与"上游没有这个能力"是两件事。
12. **不用"租户级角色"去隐藏需要"库级档位"判定的界面入口。** 知识库级授权面板（0.12.0）是唯一一处
    "服务端按**某个库**判档位、而路由门只要求 `knowledge:read`"的接口族。前端因此**不拿
    `allowed('knowledge','write')` 预隐藏它** —— 那会把"全局是 viewer、本库被授成 admin"的
    **库级管理员**挡在门外，而他正是这个面板唯一的服务对象。做法是**照样渲染、把服务端的结论
    原样呈现**：`403`（看得见但档位不够）与 `404`（库对你不可见）**分开显示、不含混**。
    ⚠️ 这不是个例而是**一条通则**：前端的 `allowed()` 只读得到**租户级**角色，
    凡判定口径细于租户级的入口，都只能"照实呈现服务端结论"，不能在客户端替服务端下结论 ——
    否则就是用一个更粗的口径去覆盖一个更细的口径。同类先例见 §7.2 的"写路径判定下移"。

13. **"允许发生"不等于"真的会发生" —— 能力声明必须配一份可核验的对账。** 通知的
    `NOTIFY_EVENTS` 白名单只说明"这个事件**允许**被投递"，**不说明它真的会被发出**。
    0.12.1 抓到的一次真实事故：`backup.failed` 从 0.8.0 起就在白名单与部署文档里，
    **全项目却没有一个 emit 点** —— 运维照文档给渠道订阅了它、以为"备份失败会告警"，
    那条路其实永远不会响（而且**不报错**，只是安静地什么都不做）。
    处置不是"删掉那个事件名"（那是把承诺改成沉默），而是**把它接上**，并把这条判断
    **变成机制**：新增 `NOTIFY_EVENT_PRODUCERS` 对账表（每个白名单事件 → 产生方文件，
    或显式的 `null` = 当前没有产生方），由回归**双向静态核验** —— 正向：表说有产生方 ⇒
    那个文件里必须真有一个 emit 点；反向：全 `app/` 字面 emit 的事件集**必须恰好等于**
    表里那批。⚠️ 两条实现细节都是踩出来的：**①** 反向扫描**必须先剥注释**，否则守卫会随
    "某人改了一句注释"而假红 —— **会假红的守卫最后一定被人关掉，那还不如没有**；
    **②** 对账表里"当前没有产生方"必须是**显式的一行 `null`**，不许靠"没写在表里"来表达
    （默认通过 = 漂移没有阻力）。**通则**：凡"声明一个能力存在"的地方（事件白名单、
    能力矩阵、权限表、文档里的 ✅），都要问一句"**它的实现点在哪、谁在保证两者不分家**"。
    同类先例：§A2-(a) "写了却没接通的护栏比没有更危险"、§B7 的"声明 = 实现"不变式。

14. **运维必需项里，只有一类"不做也不会报错" —— 它必须在自检里有位置。** 备份是典型：
    没配自动备份任务、目录里一份备份都没有、告警没人订阅 —— 这三种状态**都不会让服务报错**，
    界面上也看不出异常，直到真的需要恢复那天。所以 0.12.1 把 `--check` 扩到第 `[14]` 项
    「备份与恢复」（只读探测：任务 / 产物 / 订阅），并要求它**给出可照做的下一步**而不是
    只报状态。**通则**：判断一项要不要进自检，标准不是"它重不重要"，而是
    "**它坏掉/缺失时，运行期还有没有别的途径能发现**"—— 没有的，就必须进自检。

15. **会成串发生的事件，接上"产生方"的同时必须接上"节流" —— 两件事是一次动作，不是两次。**
    0.13.0 把 `quota.blocked` 接上时，如果只做"拦截时 emit 一下"，
    结果是**每次都出站**：一个租户撞上配额后，接下来每一次提交都会发一条。
    **刷屏的告警等于没有告警**（收件人会把整个通道静音，
    于是真正不同的那条也被埋掉）。所以接产生方的同一个提交里定了节流策略：同一
    (租户, 事件, 分键) 在窗口内**最多出站一次**（分键是"哪个指标"）。
    ⚠️ 三条一起写下来的判断：
    - **合并掉的是"通知"，不是"事实"。** 每一次拦截仍**逐条进审计**，
      所以"合并"不会让任何事变得查不到；反过来也成立：**告警通道安静不代表没发生**。
    - **节流窗口是"没有渠道订阅"时不该消耗的**。顺序必须是"先确认有人会收到，再计时"——
      否则一次还没配渠道的拦截会把窗口占掉，等运维配好渠道后，窗口内真正该收到的那条反被合并没了。
    - **出站不许阻塞、也不许影响判定**。配额拦截必须立刻把 403 返回给调用方；
      让一次 webhook 超时拖住（或改变）拦截结果是错误的优先级（同"审计留痕失败不影响拦截本身"）。
    **通则**：一个动作如果"每次发生都值得告警"，那它要么发生得很少，要么就必须有合并规则 ——
    问一句"**最坏情况下这条通道一分钟会被灌多少条**"，答不上来的先别接。

16. **基准工具不能只"报数"，还要报出"这个数是怎么被量出来的" —— 否则工具本身会成为误读源。**
    0.13.0 第一次真跑开环定速（`--open-rates`）时发现：发包端与服务器共用一个事件循环，
    服务端一卡，**发包节拍也被拖慢** —— 目标 30 req/s 只发得出去 17.6，而这一档的错误率是 0。
    单看汇总会得到"30 req/s 系统扛住了"这个**与事实相反**的结论；真相是**这个速率根本没被发出去**。
    处置有两步，缺一不可：
    - **把量法本身修对**：新增"独立发包端"（另起一个进程，另一个事件循环）——
      `--open-sender=process`。两个进程仍在**同一台机**上，所以它解决"发包节拍被拖慢"，
      **不**解决"客户端与服务器争 CPU"；这句话必须和数字一起说，否则新数字会被读成它证明不了的东西。
    - **让工具自己拒绝给出假结论**：同进程模式下打印**"这个模式问不出拐点"**，
      而不是照常打出一个看起来正常的数。**通则**：工具里每一个"可选模式"都要能回答
      "它测不出什么"；一个只会报数的基准，比没有基准更容易让人做错决定。

17. **守卫必须先被证明"会红"，才算守卫。** 0.13.1 新增的三类检查（门禁判据 / 模块孤儿 /
    前端分片对账）都是**先故意改红、再撤掉**验过的：临时造一个不可达模块、一条指向不存在文件的
    `import`、一片没写进 `index.html` 的分片，确认它**真的会红、且报的位置也对**，然后删掉临时件。
    理由是：本项目最怕的失败不是"红"，而是**假绿** ——
    - **只会报绿的检查，和没有检查在观感上完全一样**，但前者更坏：它让人**从此不再去看**。
    - 所以 0.12.1 那条"反向扫描必须先剥注释"不是洁癖：不剥注释的守卫会因一句注释而**假红**，
      而**会假红的守卫最后一定被人关掉**（0.13.0 那次的压测对账假红同理 ——
      **假红的对账比没有对账更坏**）。
    - 同理，**门禁不能只看退出码**：脚本没跑到末尾时退出码也可能是 0，那意味着"什么都没检查"。
      判据必须是「退出码为 0 **且** 找到约定的末行 **且** 末行里的数字是 0」三条**同时**成立；
      两者矛盾时按不通过处理。**SKIP 也不算通过**（没有外部条件 = 没验收），要单独计数。
      ⚠️ 0.15.0 又补了这条纪律的一个洞：**"是不是 SKIP"要看末行的结构化字段，不看提示的措辞。**
      原实现只认一种拼法（`^SKIP$` 单独一行），而外部内核验收写的是
      `上游当前不可用 —— SKIP（不是通过）。` —— 于是"这次一条都没验收"被记成 ✓，
      汇总里的"通过 13/14"跟着虚高。现在按末行的 `skipped=N` 判（改措辞不会动它），
      文本匹配只作兜底。**同一类错的两种形态**：判据依赖了"人怎么写提示语"。
      （顺带一个自己踩的坑：第一版写成从正则匹配结果里取"末行"，而匹配结果只是
      `DONE fails=0` 这一段、不含同一行后面的 `skipped=1` —— **改红实验里它仍然是绿的**。
      再次说明：守卫必须**看着它红一次**。）
    **通则**：任何守护性代码（回归 / 审计 / 门禁 / 写进文档的断言）在提交时都要问一句
    "**我凭什么相信它会红**"；答不上来的，先造一个红给它看。

18. **扫描范围比扫描规则更容易漏 —— 而"靠流程记住"不算防线。** 0.15.0 收口时做了一次
    "**独立解包 → 换一套规则复扫**"（不复用打包脚本自己的结论），在 `tools/test-core.mjs` 里
    抓到**一枚从本机 `data/config.json` 整行抄来的真实内核令牌**。它属于 `tools/`，
    **会随发布包分发**，而打包脚本每次都报"泄漏命中 0" —— 因为它的内容扫描**只覆盖 `app/`**。
    三条要记住：
    - **规则写得再细，扫不到那个目录就等于没有。** 补的是范围纪律：**凡是会随包出去的目录
      （`app` / `public` / `tools` / `docs`）都要进扫描范围**。同一类错 0.14.0 已经犯过一次：
      `.gitignore` 里的 `data/` 没锚定，把源码目录 `app/data/` 一起忽略了（整个数据层从未进版本库）。
    - **"发版 SOP 里有这一步"不是防线，清单里才是。** 所以 `pack-release.mjs` 本身被写成
      门禁第 14 项 `packscan`；**人会漏，别指望流程**。
    - **两条互不相干的通道要各自过一遍**：内容里没有 ≠ 条目名里没有（反之亦然）。
      "独立解包之后再换一套规则扫"之所以能抓到东西，正是因为它**不复用**被检验方的判断。

---

Copyright 2026 liwei（易智瑞西安） <liwei@geoscene.cn>.
