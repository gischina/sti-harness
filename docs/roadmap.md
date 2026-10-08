# 路线图

> 首期目标：**一个大版本内落地四项能力**（身份与权限 / 企业知识与检索 / 治理与审计 / 能力分发）。
> 里程碑按依赖排序，M0 与契约层是地基，必须先稳固。

---

## 里程碑总览

| 里程碑 | 主题 | 依赖 | 预估规模 |
|---|---|---|---|
| **M0** | 骨架与契约层 | — | 大（决定后面所有事的形状） |
| **M1** | 身份与权限 | M0 | 大 |
| **M2** | 企业知识与检索 | M0、M1（隔离依赖） | 大 |
| **M3** | 治理与审计 | M0、M1 | 中 |
| **M4** | 能力分发 | M0、M1、M3（可见性治理） | 中 |
| **M5** | 企业化收口 | M1–M4 | 中 |

> M3 与 M2 可并行（治理不依赖检索）。M4 建议等 M3 的治理规则表稳定后再动。
>
> **交付进度**：`0.1.0` M0 ✅ → `0.2.0` M1 ✅ → `0.3.0` M2 ✅ → `0.4.0` M3 ✅ →
> `0.5.0` M4 ✅ → `0.6.0` M5 ✅（全部五个里程碑交付）→ 此后是 M5 之后的**持续收口与能力补齐**（P0/P1-x 与各轮体检收口），
> **当前 `0.19.0`**（完整的新旧对照见 [`versioning.md`](versioning.md)）。
> 路由数随之增长：33（M0 收口）→ 42（M1 后）→ 49（M2 后）→ 56（M3 后）→ 68（M4 后）→
> 69（M5 后）→ **88（P0 + P1-1 后）**。实测分布：M0 13 / M1 25 / M2 10 / M3 11 / M4 15 /
> M5 3（备份创建 + 列表 + 校验；恢复刻意不做在线接口）/ **P0 2**（工作台与流式回合挂在既有资源上，
> 未独占编号）/ **P1 9**（模型中心）。

> ⚠️ **建议重切（见 `docs/feasibility.md` §2.3）**：把「四项能力压一个大版本」改为两个可交付版本，
> 避免 M2（最重且最不确定）延期拖垮整体：
>
> | 版本 | 内容 | 对外可用性 |
> |---|---|---|
> | **「部门级可用版」** | M0 + M1 + M3 + **精简 M2**（纯 Node 格式 + bigram 检索 + 无 embedding 降级） | 可登录、可管人、可审计、可查资料 |
> | **「完整企业版」**（即后来的 `0.6.0`） | 补全 M2（外部解析 + 向量混合检索）+ M4 + M5 | 完整四项能力 |
>
> 理由：**身份与治理是「能不能用」的门槛，知识检索是「好不好用」的加分**。
> 先交付前者能最早拿到真实反馈；知识检索先用零依赖纯文本路径跑起来，向量与复杂解析后补。

---

## M0 · 骨架与契约层

**目标**：把 dsh-console 的单体 `server.cjs` 拆成有层次、可测试的模块，并让契约层立起来。

> ✅ **状态：主体已完成（0.1.0）** —— 5 项验收标准全部实测通过，详见本节末尾。
> ⚠️ **但有 1 项交付物未完成**：`app/kernel/fixtures/`（见下方「M0 缺口」），
> 该缺口**不阻塞**其余验收，但**是升级 DSH 前的必办项**。

### 交付物

- [x] `app/main.mjs`：进程装配、配置解析、优雅退出（SIGINT/SIGTERM）、`--check` 模式
- [x] `app/http/router.mjs`：**路由唯一真源**（表含 `id/method/path/capability/scope`），中间件链由 `scope` 推导
- [x] `app/http/middleware/registry.mjs`：requestId、日志 span、请求上下文、内存滑动窗口限流
- [x] `app/data/db.mjs`：四个原语 + WAL + 迁移执行器（`migrations/NNNN_*.sql`）
- [x] `app/data/migrations/0001_init.sql`：29 张表/视图（含 FTS5 虚拟表 + 同步触发器）
- [x] `app/kernel/contract.mjs`：契约定义 + 事件归一（语义字段名自持，上游字段名只准出现在 `dsh-provider/events.mjs`）
- [x] `app/kernel/dsh-provider/`：`client` / `transport` / `events` / `capability` / `compat/` 五件套，迁移 dsh-console 已有实现
- [x] `app/kernel/mock-provider.mjs`：确定性 provider
- [x] **前提验证**：DSH 是否支持自定义模型 base URL（决定 model gateway 能否成立）
      → ✅ **已验证：支持**，结论与 5 条硬约束见 `feasibility.md` §1.2.3.1
- [x] `app/kernel/fixtures/` + `tools/record-fixtures.mjs`：**真实上游事件流脱敏录制 + fixtures 回归**
      —— M0 未交付，**已在 M1 开头补齐**（见下方「M0 缺口已补齐」）
- [x] `app/kernel/dsh-provider/upstream-contract.mjs` + `tools/snapshot-upstream-contract.mjs`：
      **上游契约快照**（从上游类型定义提取事件名/字段名，可自动比对差异）—— 补 fixtures 时新增的第二道防线
- [x] `start.cmd` / `check.cmd` / `start.sh` / `check.sh`：环境自检（Node ≥22.13、目录可写、SQLite 可用、上游可达 + **版本门禁**）+ 启动
- [x] `tools/audit-layering.mjs`：分层审计脚本（见下方验收）
- [x] `tools/test-core.mjs`：**自研极简 harness**（不用 `node:test`，因为其 `after()` 输出会早于 reporter 刷新，破坏「末行 `DONE fails=N`」约定）
- [x] 运维文档首版 [`deploy.md`](deploy.md)（部署、配置、备份、打包、排障、诚实边界）

> 与初版计划的差异（**记录原因，便于回溯**）：
> 1. 中间件按 **`registry.mjs` 集中注册**，而不是每件一个文件。M0 只有 2 件实装 + 5 件占位，
>    分散成 7 个文件反而让「链是怎么拼起来的」难以一眼看全；M1/M3 实装时再按需拆分。
> 2. 回归脚本**不用 `node:test`**，改为自研 40 行 harness（顺序 `await` + `t(name, fn)` + 末行汇总），
>    原因是 `node:test` 的报告器刷新时机无法保证「末行输出 `DONE fails=N`」这条项目约定。
> 3. 加了 `app/util/quiet-warnings.mjs`（必须第一个 import），收敛 `node:sqlite` 的
>    `ExperimentalWarning` —— 否则每次启动都刷一屏警告，会淹没真正的问题。
> 4. `app/platform/` 在 M0 **只有表结构就位，没有代码**：占位目录留到 M1 再建，
>    避免出现「空目录看起来像已完成」的假象。

### 验收标准

1. `node app/main.mjs --check` 在**没有 DSH** 的机器上也能逐项输出（契约层用 mock-provider 自检）；
2. `mock-provider` 下能跑通「创建会话 → 提交一轮 → 收到归一化事件流 → 落库 → 重放」全链路；
3. `tools/audit-layering.mjs` 判定：`app/platform/**` 与 `public/**` 中**零 DSH 专有名词命中**；
4. 迁移可重复执行且幂等；从空库到可用状态一条命令完成；
5. 全部回归脚本末行输出 `DONE fails=0`（沿用 dsh-console 约定）。

### 验收实测结果（2026-09-30）

| # | 标准 | 实测 |
|---|---|---|
| 1 | 无上游也能自检 | ✅ 本机上游要求会话鉴权 → 自动降级 mock 并说明原因；自检 10 项逐项输出，末行「结果：无阻塞问题，2 个提示」 |
| 2 | mock 全链路 | ✅ 创建会话 → 提交一轮落库 **8 条事件**（`eventsWritten:8, lastSeq:8, truncated:false`）→ 事件重放 → 用量汇总 `{input:128,output:64,reasoning:16}` 全部一致 |
| 3 | 分层审计零命中 | ✅ `DONE fails=0`。过程中抓到并修掉 2 处真实泄漏（前端直呼运维变量名、文案出现上游目录名），修法是**加接口回传变量名**而不是把字符串藏起来 |
| 4 | 迁移幂等 | ✅ 重复执行 `applied=0`；空库一条命令到可用 |
| 5 | 末行 `DONE fails=0` | ✅ `test-core.mjs` **36 用例**（M0 收口时：补上 fixtures 后从 23 增至 36，**0 跳过**）／`audit-layering.mjs` 双脚本均通过。**注**：M1 完成后该脚本已增至 58 用例，此处数字是 M0 当时的实测记录 |

**附带验证**：33 条路由（M0 13 / M1 9 / M2 3 / M3 4 / M4 3 / M5 1）；
501 / 404 / 405 错误语义正确；`x-sti-passthrough: auth,tenant,rbac,quota,audit` 如实自报未实装中间件；
`start.cmd` / `check.cmd` 在纯 cmd.exe 下实测通过（`.cmd` 保持纯 ASCII）。

> 📌 M1 完成后路由为 **42 条**（M0 13 / M1 18 / M2 3 / M3 4 / M4 3 / M5 1），
> `x-sti-passthrough` 收敛为 `quota,audit`。上面那行保留 M0 当时的数字以便回溯。

**实施中修掉的 3 个真实缺陷**（记录在此，因为它们都属于「看起来正常、实际在说假话」）：
1. **版本门禁在 mock 模式下警告了一个不存在的上游版本。**
   `mock-provider.describe().kernelVersion` 返回的是**契约版本** `1.0.0`，而判定只比对版本号，
   于是自检与状态接口都会报「1.0.0 不在已验证矩阵内」。
   修法：门禁抽成 `app/config.mjs` 的**单一真源** `versionGate(version, mode)`，mock 模式返回 `n/a`
   并说明「没有上游版本需要校验」；自检里也不再把契约版本打成「版本」。
   已加回归用例钉死（4 条配置/门禁用例）。
2. **启动横幅把 5 个占位中间件显示得像已实装。**
   `context → ratelimit → auth → tenant → rbac → quota → audit` 会被读成「7 个都在工作」。
   改为 `context → ratelimit ｜ 占位（不拦截）：auth(M1)、tenant(M1)…`。
3. **中间件链渲染里有一处引用已弃用函数的死代码**（`pipeline.mjs` 的 `finally` 块），已清除。
4. **补齐 fixtures 时又抓出 3 处会静默失效的映射错误**（工具结果全空、消息文本全丢、结束原因丢失）——
   三处都不抛异常、不打日志，属于最难发现的一类。详见下方「M0 缺口已补齐」。

**M0 未做的事（有意为之，不是遗漏）**：登录、鉴权、知识检索、审计、能力分发一律未实装，
但**响应头与自检输出会如实标注**——`0.1.0` 只适合受控的单机环境试用，不要放到多人可访问的网络上。

### ✅ M0 缺口已补齐：fixtures 回归（在 M1 开头完成）

**缺口记录（保留，便于回溯）**

| 项 | 说明 |
|---|---|
| 原欠什么 | `app/kernel/fixtures/` 与 fixtures 回归用例（真实上游事件流 → `events.mjs` → 断言归一化结果） |
| 当时为什么没做 | 上游要求浏览器会话鉴权，判断拿不到可用事件流；`mock-provider` 的数据**不能替代**——它只会复制我们自己的假设 |
| 风险敞口 | 在补上之前，「事件字段静默变空」这类最隐蔽的破坏性变更无法被自动发现（见 `feasibility.md` §6.3、§6.4） |
| 什么时候要求补 | **M1 开工第一件事**，且必须在任何一次上游升级之前完成 |

**补齐方式（与当初计划不同 —— 换了一条不需要令牌的路）**

当初打算「用带 `?token=…` 的地址接通上游、跑一轮会话」。实际发现**根本不需要令牌**：

上游自己就把每轮会话写在
`<DSH_HOME 或 ~/.dsh>/sessions/<projectKey>/<sessionId>/session.vN.jsonl.zstd`，
那是**拼接的 zstd 帧容器**（首帧 header，其后每帧一个事件批次）。
于是录制变成「读上游日志 → 按魔数切帧解压 → 脱敏 → 存 fixture」，
纯离线、不碰浏览器会话，`node tools/record-fixtures.mjs` 一条命令完成。

> 附带一条经验：那个文件**不能用流式解压器**读（会在第二帧报 `Unknown frame descriptor`），
> 必须按魔数切帧逐帧解压。这个坑已写进 `tools/record-fixtures.mjs` 的注释。

**补齐后的收获（这才是重点）**

有了真实事件流，**立刻查出三处会静默失效的映射错误** —— 三处都不抛异常、不打日志，
只会让界面「安静地少点东西」：

| # | 错在哪 | 后果 |
|---|---|---|
| 1 | `tool/result` 的真实字段是 `data.message`，原实现只找 `result`/`output` | **工具结果全部为空** |
| 2 | `message.content` 是**内容块数组** `[{type:'text',text:'…'}]`，不是字符串 | 只认字符串的话**消息文本全丢** |
| 3 | `turn/end.data.reason` 是**对象** `{kind}`，不是字符串 | **结束原因静默丢失** |

另有两条结构性事实被确认：

- 真实信封是 `{type, seq, time, data, surfaceOp?}` —— **业务字段全在 `data` 里**（不在顶层），
  `seq` 从 0 开始且连续（我们直接沿用，便于与上游日志逐条对账），`time` 是毫秒时间戳；
- 真实事件类型有 **20 种**，比 `SessionEventMap` 的 14 个核心类型多出 9 种**插件自有事件**
  （`session/title`、`sandbox/mode`、`approval/policy`、`workspace/changes` 等）——
  这些**只有录制真实流才看得到**。现在统一折叠成 `lifecycle` 并保留原始类型名；
  用的是**白名单**，所以真正的未知类型仍会落成 `unknown`（区分能力没有被吞掉）。

**补齐后新增的两道防线（互补，不是替代）**

| 工具 | 看什么 | 何时跑 |
|---|---|---|
| `node tools/snapshot-upstream-contract.mjs` | 上游**类型定义**里的事件名/字段名是否变了 | 上游升级后 |
| `node tools/record-fixtures.mjs` + fixtures 回归 | 上游**真实事件流**的结构是否变了 | 上游升级后、发现未知事件时 |

> 📌 这条缺口**记在这里而不是悄悄跳过**，正是本项目「诚实数据源」原则的执行。
> 补齐后同样保留记录 —— **当初判断错在哪（以为必须先拿到令牌）比"现在做完了"更值得留档。**

---

## M1 · 身份与权限

**目标**：没有登录就没有企业。「谁能看什么、能做什么」是全站前提。

> ✅ **状态：已完成（0.2.0）** —— 5 项验收标准全部实测通过，详见本节末尾。

### 交付物

- [x] `platform/identity/`：组织 / 部门 / 用户 / 角色的仓储与服务
- [x] 口令：scrypt + 每用户 salt + `timingSafeEqual` 比较（哈希串**自描述**，调参不使旧口令失效）
- [x] 会话：HMAC-SHA256 令牌（服务端只存 `token_hash`）、过期与吊销
- [x] `middleware/auth.mjs` / `tenant.mjs` / `rbac.mjs`
- [x] `platform/identity/permissions.mjs`：**声明式**权限表（角色 × 资源 × 动作）
- [x] 内置角色：`owner` / `admin` / `member` / `viewer`
- [x] 凭据管理：AES-256-GCM 加密落库，接口永不回显明文（连密文都不回显）
- [x] 初始化向导：空库首次访问 → 建组织 + 建管理员账号 → 配模型凭据
- [x] `api_keys`：给自动化/集成用的长期令牌（带 scopes）
- [ ] SSO / LDAP 适配器接口（**延后到 M5**：本机没有可对接的目录服务，此时留空接口等于"看起来做了"）
- [x] 前端：登录页、账号管理页、角色管理页、凭据页
- [x] **部门出口补齐**（0.11.1 补，对应体检 §B8）：原先 `departments` 表、4 个仓储函数、
      `createUser` 收 `deptId` 都在，**却没有任何路由能创建或列出部门** ——
      `countDepartments` 恒为 0、`deptId` 永远只能填 NULL，是一个"能引用、不能创建"的外键。
      现在补齐 `GET/POST /api/identity/departments` 与 `PUT /api/identity/users/:id`（改姓名 / 部门归属），
      账号页加了部门面板（含真实成员数），并**顺手堵掉一个跨租户漏洞**：
      `deptId` 原先原样写库，传别家的部门 id 也能落进去。
      ⚠️ 两条如实边界：**不提供删除与改名**（会让归属悬空，属产品决策）；
      **部门不是权限载体** —— 挂进"管理员部"不会得到任何权限，权限只来自角色与用户组。

### 计划外增加的交付物（做了就要记，不能算"顺手"）

- [x] `app/http/middleware/auth.mjs` 内的 **CSRF 判定**（`csrfVerdict`）。
      理由：cookie 认证一旦用于浏览器，就是"浏览器会自动替用户带上凭证"的场景。
      `SameSite=Lax` 已经挡住现代浏览器的跨站 POST，但它**是浏览器行为、不受我们控制**，
      且被挡住时是**静默的**（cookie 干脆没带上 → 表现成"未登录"）。
      显式判定能留一条可审计的记录，因此补上这道纵深防御。
- [x] `tools/test-http.mjs`：HTTP 端到端回归。
      触发原因是一个真实缺陷——凭据写入成功、接口却回 `hasValue:false`。
      它不抛异常、不打日志，只在响应体里安静地错一个字段。**手工 curl 能看见，但没人会每次发版都点一遍。**
      这个脚本自带临时库与随机端口，因此不依赖本机是否已启动服务，也不碰真实 `data/`。

### 验收标准（附实测）

| # | 标准 | 实测（2026-09-30） |
|---|---|---|
| 1 | 权限判定函数 100% 被单元测试覆盖（纯函数，正例 + 反例） | ✅ 4 角色 × 16 资源 × 5 动作 = **320 格逐格穷举**，与测试内**独立重写的参考实现**对照一致；另加未知角色 / 空入参 / 大小写 / `'*'` 收窄等边界 |
| 2 | 未登录访问任一非公开路由 → 401；越权 → 403 **且审计里有一条 `denied`** | ✅ 5 条受保护接口未登录全 401（且**文案完全一致**，不泄漏失败原因差异）；viewer 建用户/改角色/看凭据全 403；审计里 `auth.authenticate`（匿名）与 `access.denied`（已登录）两类 `denied` 均落库 |
| 3 | 令牌在服务端以哈希形式存储——直接读数据库拿不到可用令牌 | ✅ 按"期望的 HMAC"回查命中即证明落库形态；换主密钥算出的哈希不同；把库里的哈希原样当令牌用 → 401；整表扫描无明文 |
| 4 | 凭据表中没有任何明文字段；导出/日志里不出现凭据明文 | ✅ **列名层面**就没有 `plain/secret/token/key/password/value`（只允许 `cipher`）；同一明文两次加密结果不同（每次新 IV）；写入/列表/初始化响应体里都不含明文，也不含密文 |
| 5 | 初始化向导在全新机器上从零到可登录 ≤ 3 分钟 | ✅ `--check` → 起服务 → 向导 → 登录，全程 ≤ 1 分钟（scrypt 单次约几十毫秒，不是瓶颈） |

**回归规模**：`test-core.mjs` **58 用例**（M0 的 36 + M1 的 22）/ `test-http.mjs` **41 用例** /
`audit-layering.mjs` / `snapshot-upstream-contract.mjs` / `record-fixtures.mjs` —— 全部末行 `DONE fails=0`，**0 跳过**。

**实施中修掉的 3 个真实缺陷**：

1. **凭据写入成功却报 `hasValue:false`。**（本轮最先抓到的）
   `credentialInfo()` 依赖 `row.cipher`，而列表查询**刻意**不带 `cipher` 列（纪律：密文不出仓储层），
   于是刚写进去的凭据被判成"没值"。修法：列表加 `has_cipher` 计算列，service 改用
   `getCredentialForUseById()` 判定 —— 两条纪律（不带密文 + 如实报有值）都保住。
   **这条直接催生了 `tools/test-http.mjs`。**
2. **"令牌怎么带过来的"与"令牌是什么东西"被混成一个字段。**
   auth 中间件把 `via` 同时用于"携带方式"（authorization / cookie）与"凭证种类"（session / api-key），
   于是 `/me` 对 API Key 认证请求报出 `via: 'authorization'` —— 看着没错，实际答的是另一个问题。
   修法：拆成 `auth.via`（携带方式）与 `auth.credential`（凭证种类）两个字段。
   CSRF 判定必须看前者，而"这是不是集成密钥"要看后者 —— 合成一个就会问错问题。
3. **18 条 M1 路由漏标里程碑。** `/api/system/routes` 的"按里程碑"统计里多出一坨「（未标注）18」。
   那不是如实报告，是把统计变成噪音。修法：在 `identityRoutes()` 出口统一盖章，避免逐条漏改。

**M1 未做的事（有意为之，不是遗漏）**：

- **配额与审计查询接口仍是占位**（`quota` 完全不拦截、`audit` 只写不收尾）。响应头
  `x-sti-passthrough: quota,audit` 与启动横幅都会如实标出来 —— 已实装的 auth/tenant/rbac
  则**不再出现**在该头里（这条本身也进了回归）。
- **SSO / LDAP 未实装，且没有为它预留任何表结构或登录接口**（⚠️ **2026-10-01 复核更正**：此处原写"只有表结构与字段位置"，与事实不符 —— `users` 表是纯本地账号模型，只有 `username` + `pwd_hash`/`pwd_salt`，无 `external_id` / `identity_provider` 之类字段；登录链路是 scrypt 本地口令 + 会话令牌，无 provider 抽象。接 SSO 属**新增字段 + 新增抽象**，不是"接线"）。见上面交付物里的说明。
- **审计链只做"事后改数据"的防护。** 有写权限的人整表重写链是防不住的；真正的防篡改需要把链尾
  定期外发，那是 M5 备份/导出的事。**现在不做，也不假装做了。**

---

## M2 · 企业知识与检索

**目标**：让 Agent 能查企业自己的资料，并且**答案可溯源**。

> ✅ **状态：已完成（0.3.0）** —— 5 项验收标准全部实测通过，详见本节末尾。
> 📊 10 万 chunk 规模实测数字（含机器、口径、规模边界）见 [`benchmark.md`](benchmark.md)。

### 交付物

- [x] `platform/knowledge/parsers/`：纯 Node 解析 md / txt / csv / json / jsonl / html
- [x] 外部命令解析适配器：PDF（`pdftotext`）、DOCX/XLSX/PPTX（`libreoffice --headless` 转文本）
      —— **探测不到时明确降级并在页面标注**，不假装成功
- [x] 分块策略：按标题层级 + 长度上限 + 重叠；保留 `page` / `heading` 等定位元数据
- [x] **中文 bigram 预处理**：写入侧切重叠双字串入 `bigrams` 列，查询侧同切分（短语优先 → `OR` 宽松 → 单字 `LIKE` 兜底）——**不得裸用 unicode61**（feasibility §1.2.1）
- [x] Embedding provider 抽象：OpenAI 兼容 / Ollama / **关键词降级**（无 embedding 时只用 FTS5）
- [x] `worker/` 池：解析、分块、向量化全部在 `worker_threads` 内，避免阻塞事件循环
- [x] 检索：FTS5 `bm25`（**中文经 bigram**）+ 暴力余弦 + **RRF 融合**（rerank 留待 M5）
- [x] **中文召回回归**：断言「权限」「管理」「平台」等 **2 字词**能命中（unicode61/trigram 都会失败，必须有此用例钉住）
- [x] 引用溯源：`chunk → document → 页码/章节/行号`，检索结果带可回溯引用链
- [x] 库级隔离：按租户 + 知识库 + 可见范围过滤，检索**不得越界**
- [x] 前端：知识库管理、文档导入（文件/目录/URL/纯文本）、分块预览、召回测试

### 验收标准

1. 10 万 chunk 规模下，单次混合检索 P95 在可接受范围（写入文档实测值，不写「很快」）；
2. 检索结果**每条都带可回溯的引用链**，缺定位信息的分块必须被标记而不是静默返回；
3. 越权检索测试：租户 A 无法召回租户 B 的任何分块（含 FTS5 路径与向量路径**两条都要测**）；
4. 无 embedding 配置时自动降级为纯 FTS5，页面明确显示当前检索模式；
5. 解析失败的文档状态为 `failed` 且带原始错误，不进入可检索集。

### 验收实测结果（2026-09-30）

| # | 标准 | 实测 |
|---|---|---|
| 1 | 10 万 chunk 混合检索 P95 实测 | ✅ **文本检索 P95 430 ms**（稀有线 0.91 ms）／**向量暴力扫描 P95 1231 ms**／**服务层混合检索 P95 1931 ms**；入库 61 s（1631 chunk/s），库文件 306.6 MB。机器为 i7-8550U（15W 笔记本），8 项算法守卫断言全绿、`DONE fails=0`。**全量数字与口径见 [`benchmark.md`](benchmark.md)** |
| 2 | 每条结果带可回溯引用链；缺定位信息必须被标记 | ✅ 返回结构为 `{ rrf, ftsRank, vectorRank, citation:{docTitle, headingPath, page, lineStart, locationKnown} }`。**缺定位信息的分块带 `locationKnown:false` 并在前端显式标"无定位信息"**，不静默返回；`headingPath` 为空数组也不当作"已知"。定位信息**包含行号**（曾经只认 page/heading，导致纯文本块被误判为不可定位） |
| 3 | 越权检索：FTS 与向量**两条路径都测** | ✅ 租户 A 命中租户 B 的分块 = **0**（两条路径各一组用例）；知识库级（同租户不同库）同样 0；**10 万规模下复验仍为 0**（见 `benchmark.md` §6 第 7、8 条）。**注**：这两条隔离是**在 SQL 里做的**（`kb.tenant_id = ?` + `d.status='ready'`），不是取回后在内存过滤 |
| 4 | 无 embedding 时降级为纯 FTS5，页面显示当前模式 | ✅ `embed()` 未配置时返回 **`null`**（**绝不返回零向量** —— 零向量会让余弦恒为 0，是"假装在工作"）；`knowledge.status` 的 `embedding.mode` 如实取 **`'none'`**（配置后为 provider 名，如 `openai-compat`）并附降级说明；前端状态条显示 **`纯文本检索`** 徽标 + "bigram + FTS5 bm25"（配置后变为 `混合检索` 徽标 + 模型名与维度）；检索结果里 `vectorRank` 为 **`null`** 而非伪造名次 |
| 5 | 解析失败的文档 `failed` 带原始错误，不进入可检索集 | ✅ 探测不到 `pdftotext` / LibreOffice 时抛 `ParserUnavailableError`，文档置 `status:'failed'` 且 `error` 保留**原始错误文本**（不吞不改写）；检索 SQL 里 `d.status = 'ready'` 硬过滤 —— **失败文档在两条检索路径上都不可能被召回**（有用例钉住） |

### 计划外增加的交付物

- [x] `tools/bench-search.mjs` + [`docs/benchmark.md`](benchmark.md)：
      验收标准 ① 写的是"**实测** P95"，那就必须有个能被重跑复现、能看出回归的脚本。
      触发原因是**跑基准时抓出两个真实性能缺陷**（见下）。零依赖、自带临时库与 stub embedding。
- [x] `tools/bench-concurrency.mjs` + [`docs/benchmark-concurrency.md`](benchmark-concurrency.md)
      （0.11.0 期间补，对应体检 §B11）：
      此前全项目**没有**并发/长稳脚本，"能扛多少并发用户"这个最重要的数是空的。
      现在**对真实 HTTP 服务**做闭环阶梯压测（吞吐 / P50·P95·P99 / 错误率 / RSS / **事件循环滞后**），
      并且**跑完直接查库对账**防"快是因为丢了写"。
      实测结论：单进程混合负载**约 30 req/s 即饱和**，32 路时事件循环滞后 P95 = 742 ms
      （**0.13.0 逐场景复跑为 799 ms —— 同一量级**）。
      ⚠️ 当时仍欠**开环定速**与**长稳实跑** —— 文档里写明了，别当已经做了。
      （**已在 0.13.0 补上**：开环定速配上了**独立发包端** `--open-sender=process`
      —— 此前同进程开环"目标 30 req/s 只发得出 17.6"，会把"发不出去"读成"扛住了"；
      长稳 30 分钟也真跑了。见版本表 `0.13.0` 行。）
- [x] `tools/test-frontend.mjs`：**真起服务录真实响应 → vm 回放驱动 `app.js`**。
      起因是上一轮发现前端 `loadAll()` 里写着裸的 `loadStatus()` —— 登录后必抛 `ReferenceError`。
      桩数据测不出来，因为它测的是"我以为的响应形状"而不是"服务真的返回什么"。

### 回归规模

`test-core.mjs` **92 用例**（M0 36 + M1 22 + **M2 34 条纯函数**）／
`test-http.mjs` **41 用例**（补上 M2 装配）／
`test-knowledge.mjs` **34 用例**（解析 / 分块 / bigram / 检索 / 隔离 / 降级）／
`test-frontend.mjs` **26 用例**（真实响应回放）／
`audit-layering.mjs` / `bench-search.mjs` —— 全部末行 `DONE fails=0`，**0 跳过**。

合计 **193 个回归用例**。

### 实施中修掉的真实缺陷（4 个）

前 3 个都是**功能全对、结果全对，只是慢或者悄悄退化**，最后一个直接踩在验收标准 ② 上。

1. **FTS 查询计划退化为全库扫描。** 常见词与稀有词**一样慢**（命中集大小不影响耗时），
   因为 `JOIN chunks c ON c.id = chunk_fts.rowid` 被 SQLite 重排成「先按 `kb_id` 扫出库内全部 chunk，
   再逐条回查 FTS 虚拟表」。改 `CROSS JOIN` 强制 MATCH 驱动后，**2 万 chunk 实测：常见词 1150 ms → 17 ms（68×）、
   罕见词 299 ms → 0.32 ms（900×）**。这条已写成 `bench-search.mjs` 的断言守卫生效。
2. **向量扫描白读了 (N − K) 行的正文。** 一趟要读遍范围内每一行的整条记录，最后只留 top-10。
   改两步法（第一趟窄投影只取 `chunk_id + dim + vec`，第二趟按主键回填正文）后，
   扫描趟 53.8 ms → 21.5 ms，端到端 158 ms → 137 ms（2 万 chunk）。
3. **Markdown「粘贴文本」导入丢标题层级**（**直接踩在验收标准 ②上**）。
   `parsers/index.mjs` 原来写着 `hasBuffer || !input.text ? detectFormat(...) : 'text'` ——
   **只有文本、没有 buffer 时一律按纯文本处理**，把文件名与 MIME 给的格式线索丢了。
   后果：粘 Markdown 时 `# 标题` 原样留在正文、标题层级丢失 → `headingPath: []`、
   `locationKnown:false` → 引用链退化成一整篇"无定位信息"的块。
   修法：**格式判定与"有没有 buffer"解耦**，另加内容嗅探（`looksLikeMarkdown`）并回一条 warning
   如实告知"已按标题层级切分"。已加 3 条用例钉住。
4. **`test-http.mjs` 在 M2 装配后启动即崩**。`createServer` 新增了 `deps.knowledge` 必填依赖，
   M1 套件没跟上。**这不是测试的问题，是"新依赖会打断老回归"这类真实风险** ——
   修法是在套件里真的建 knowledge 服务并补上 10 条 M2 路由的断言。

**M2 未做的事（有意为之，不是遗漏）**：

- **rerank 未实装**。roadmap 原文是"可选 rerank"，而 rerank 需要真实模型；
  现在没有任何真实模型可用于调参，硬做等于把"能跑通"当成"有效果"。留待 M5 接真实模型后评估。
- **向量检索仍是暴力扫描**。10 万规模 P95 约 1.2 s（实测），**20 万起会开始影响体验**（见 `benchmark.md` §8）。
  `VectorIndex` 抽象已预留（落在检索器装配点 `retrievers/index.mjs` 的 `createVectorIndex()`，
  换 ANN 只改这里、不改 service 调用方），但**不假装已经解决** —— 运行时超过 5 万扫描量会返回 `notes` 提示。
- **预过滤已提供，但默认关**（B2）。另一条路「先用文本命中缩候选、再在候选上算余弦」已实装
  （配置项 `prefilterVector` / `prefilterCandidates`，知识库页检索区还有一个三态开关可当场 A/B）。
  它**不是纯优化**：会给延迟带来明显改善，但**会改变最终答案**（代价与重合度的实测见
  `benchmark.md` §9）。所以默认关、并把「关 / 生效 / 退化」三态如实写在每次检索的结果里 ——
  "要不要用召回换延迟"是策略选择，不该由默认值替用户决定。
- **OCR 未做**。扫描版 PDF 走 `pdftotext` 会得到空文本，此时**如实置 `failed`** 而不是悄悄入库一条空文档。

> 📌 路由数从 M1 的 42 条增至 **49 条**（M0 13 / M1 18 / **M2 10** / M3 4 / M4 3 / M5 1）。

---

## M3 · 治理与审计

**目标**：企业敢用 Agent，取决于「出了事能查、危险操作能拦」。

### 交付物

- [x] `platform/governance/audit.mjs`：哈希链审计（`prev_hash` + `hash`），写入即校验；另含 `query()`（action 前缀/result/user/时间范围过滤，转义 `%_`）
- [x] 审计覆盖面：登录、权限拒绝、配额拦截、工具调用、审批决策、凭据变更、能力安装（11 个动作类型逐项有用例产出审计记录）
- [x] `middleware/audit.mjs`：自动收尾（结果 / 耗时 / 是否被拦截）。**收尾口径**：非 GET、或 GET 且状态 ≥400 才记；GET 成功不落链；rbac/quota 在链上先于 audit 拦截时收尾器不重复记，留痕责任在拦截者自己
- [x] `middleware/quota.mjs`：先检后放行，超限 `block` / `warn` 可配（`quotas.mode` 列，迁移 0003）
- [x] 用量采集：从契约层 `usage` 事件取**真实 token 数**（input/cacheRead/cacheWrite/output/reasoning 逐字段照抄；计费输入 = input + cacheRead + cacheWrite；TTFT/TPS 上游未给，恒 NULL 不假装）
- [x] `approvals`：敏感工具操作进审批队列（`tool_policies` 显式声明，默认 allow），前端可批准/拒绝，决策记审计
- [x] 产物留存：变更类工具产出的文件路径提取 + 会话日志导出（ZIP）—— ✅ **已于 0.5.0 开头补做**（原 0.4.0 顺延）。诚实边界：路径是**字符串层提取**（工具 args/result 里出现的路径），不是 OS 级文件追踪；工具不报就记不到，这个边界写在 `artifacts.mjs` 顶部。ZIP 为零依赖实现（`app/util/zip.mjs`，deflate + STORE 自适应）
- [x] 审计校验接口：重算哈希链，报告首个断裂点（改行、删行都能定位到**那一条**）
- [x] 前端：审计日志页（可筛选+链校验按钮）、配额与用量页（含诚实空态与口径说明）、审批队列页

### 验收标准（0.4.0 实测结果）

| # | 标准 | 实测结果 |
|---|---|---|
| 1 | 删改任一审计行后，校验接口准确定位断裂点 | ✅ `test-governance.mjs`：篡改一行的 `result` → verify 报出**该行**的 seq/期望/实际 prev_hash；删除一行 → 报出首个断裂点；用快照整行 `INSERT` 复原（复原值取自原始行，不写死）后恢复 ok |
| 2 | 覆盖度回归：每个动作类型都有用例产出审计记录 | ✅ 11 个动作类型（登录成功/失败、access.denied、governance.quota.block、tool.execute、tool.gate.blocked、审批决策、凭据变更、能力安装等）逐项断言存在且 result 语义正确 |
| 3 | 配额拦截与权限拒绝同样留痕（`result=denied`） | ✅ quota block → 403 `quota_blocked` + 审计 `governance.quota.block`（denied）；rbac 拒绝 → `access.denied`（denied）。**时序事实**：二者在链上先于 audit 中间件，`return 'stop'` 时 `ctx.auditTrail` 尚未创建，收尾器不记 —— 留痕责任在拦截者自己，这条已写进中间件注释 |
| 4 | 用量数字来自真实事件，与上游逐字段可比对 | ✅ mock 一轮 `usage` 事件 `{input:128, cacheRead:0, cacheWrite:0, output:64, reasoning:16}` 经 `recordFromEvents` 落库后**逐字段 deepEqual**；两轮汇总 `billableInput = 128+0 + 128+0 = 256`（计费输入 = input + cacheRead + cacheWrite）；turns 口径 = events 表 `turn-start` 计数（不用 usage_records 的 DISTINCT turn_id，避免漏计没有 usage 事件的回合） |
| 5 | 审批拒绝后，工具调用确实未执行 | ✅ mock provider 维护 `executedToolCalls` 真实计数：拒绝单后调用同一工具 → 403 `approval_required` 且**计数不变**；批准一次执行一次（单据置 `consumed`，重复决定 → 409）；拒绝单永久不可用 |

**实施中修掉的真实缺陷**（照例记录「看起来正常、实际在说假话」的一类）：
1. **`router.add()` 白名单静默丢字段** —— 路由对象按白名单挑字段构建，新声明的 `quotaMetric` 被丢弃 → quota 中间件永远拿到 `undefined` → **安静地放行**。修法：`router.mjs` 显式保留 `quotaMetric: def.quotaMetric || null`。这类缺陷比启动失败难查得多，回归红才暴露。
2. **`consumed('concurrent')` 起初缺 `unknownMetric:true`** —— 清单会显示 `evaluated:true` 的假正常。concurrent 未实装，现在如实返回 `used:0` + `evaluated:false` + 说明。
3. **`nowIso()` 是 UTC，`periodStart()` 最初用本地时间算边界** —— UTC+8 下会把「今天」错切 8 小时，账会少算。已改为 UTC 边界并用例钉死。
4. **`x-sti-passthrough` 头应已消失** —— M3 收口后七项中间件全部 active，该头若再出现说明有中间件退化了；`test-http.mjs` 的断言已从「头存在」改为「**必须为 null**」。

> 📌 路由数从 M2 的 49 条增至 **56 条**（M0 13 / M1 18 / M2 10 / **M3 11** / M4 3 / M5 1）。
> M3 的 11 条 = `governance.mjs` 10 条（审计查询/校验、配额增删查、用量、审批队列/决策、工具策略）+ `kernel.sessions.tools.execute`（工具网关，过审批门）。
> 回归规模：`test-core` **95**（新增 M3 纯函数 section：argsHash 键序无关、periodStart UTC 边界、纯函数不依赖 DB）/
> `test-governance` **23** / `test-http` **41** / `test-frontend` **33** / `test-knowledge` / `audit-layering` 全部 `DONE fails=0`。

---

## M4 · 能力分发

> 📌 **已开工（0.5.0）**：产物留存（M4-0）✅ —— `tool_artifacts` 表（迁移 0004）+ 路径提取
> `extractPaths` + 工具网关/回合事件的落库钩子 + `/api/governance/artifacts` +
> `/api/governance/sessions/:id/log.zip`（ZIP 内含 meta/session/events.jsonl/artifacts.json）。
> mock 内核新增 `mock.writeFile`（**真写文件**进系统临时目录，返回真实路径）——
> 产物留存靠它做端到端回归，不是纸上谈兵。
>
> 📌 **能力仓储与服务（M4-1）✅** —— 迁移 0005（MCP 健康留痕字段）+
> `platform/capability/`（visibility 纯函数 / service 仓储 / stats）+
> **契约层能力闸** `kernel/capability-gate.mjs`（停用/deny 的工具在 `listTools`
> 里立即消失，现查库不重启 —— 验收标准 1 的落点，回归断言直接调 provider）+
> 路由 10 条（清单 / ZIP 安装（失败即回滚记审计、路径穿越拒绝）/ 启停 /
> MCP 登记加密 + 真实探测（TCP 连接与命令验证，探不了如实说）/
> 三级 allow/deny 绑定 CRUD）。
> 路由 58 → **68 条**（M4 共 12 条：artifacts 2 + capability 10）。
>
> 📌 **可见性治理深化（M4-2）✅** —— **执行闸**：deny/停用的工具在工具网关
> `kernel.sessions.tools.execute` 里被 403 `tool_not_visible` 拦下（顺序：可见性 → 审批门 →
> 执行），拦截记审计 `tool.visibility.blocked`（denied）。契约层清单看不见 + 执行面调不动 =
> 「关可见性」是彻底的关，不是治理表演。回归用执行真调断言。
>
> ⚠️ **关于上面这条"执行闸"的一个前提（2026-10-02 补，B7）**：上述顺序里**最后一步
> 「执行」在真实内核上走不到** —— 上游（外部内核）的 wire 契约不提供平台侧工具执行，
> 工具网关在真内核上如实回 501 `not_supported`。因此：
>   · 第 1 道闸（可见性 403 `tool_not_visible`）**仍然是真的**，但它必须在有可用执行面的
>     内核上才谈得上"拦下一次执行"；在外部内核上，可见性/审批是**预置语义** ——
>     策略会被如实登记、审批单会正常流转，只是不存在可供平台发起的执行路径。
>   · 模型在**上游回合内自发**调用的工具由上游自己执行，不经过本网关，因此不受此限
>     （这条边界从 M3 起就写在 `approvals.mjs` 与前端审批页上）。
>   · 实测依据：`tools/verify-upstream.mjs` 阶段 4（对运行中的上游，18 个候选方法名全部
>     "不存在"，正/负对照均符合预期）。**重新评估条件**：上游把 `tools/*` 开进 wire
>     装配清单 —— 届时该阶段会**自动**出现一个判"存在"的候选。
>   · 能力声明是**推导**的（`provider.supportsToolExecution` → 门面 `toolExecutionAvailable`
>     → `describe().toolExecution` → 前端横幅 / 自检 [8]），所以"实现变了、声明没变"
>     这类反向漂移不可能发生；回归 test-core 钉的就是这条不变式。
> 另：Skill **更新检测** —— 安装时对解压目录算内容快照（SHA256），`check-update` 接口现算比对：
> `unchanged` / `changed`（目录被手动改动）/ `missing`（目录被删）/ `not_checkable`。
> 诚实边界：检测对象是平台磁盘上的安装目录；「上游出新版本」需要市场/导入源（M4-3）配合，现在不做也不装作做了。
>
> 📌 **导入导出与前端（M4-3）✅** —— `GET /api/capability/export`（MCP 连接配置
> **一律 `config: null`**——脱敏红线，导入端需补配）、`POST /api/capability/import`
> （格式校验 + 幂等 upsert，逐条报告 imported/skipped/failed）+ 前端能力三页
> （能力清单页双来源表 / 来源页导出导入 / 可见性治理页绑定 CRUD）。
> 测试基建：test-frontend 垫片补 `URL.createObjectURL`/`Blob`（Node 原生 URL 没有
> createObjectURL，真实浏览器有 —— 垫片差距归垫片）。
> 脱敏扫描断言见验收标准 4。回归规模：core 102 / http 41 / knowledge 34 / frontend 37 /
> governance 38 + audit-layering，全部 `DONE fails=0`。
> 路由 68 条（M0 13 / M1 18 / M2 10 / M3 11 / **M4 15** / M5 1）。

**目标**：把 Skill / 工具 / MCP 从「本机配置」提升为「企业可治理的资产」。

### 交付物（0.5.0 全部完成）

- [x] `platform/capability/`：skills / tools / mcp_servers / capability_bindings 仓储与服务（迁移 0004 产物留存表 + 0005 MCP 健康字段，只增不改）
- [x] 清单：Skill（登记 + 内核探测双来源）、工具（内核探测 + 可见性判定）、MCP 服务及其健康状态（真实探测，探不了如实 `unknown`）
- [x] 安装与启停：ZIP 包安装（路径穿越拒绝、失败即回滚）；启停现查库、不重启进程
- [x] 版本与更新：安装时内容快照（SHA256），`check-update` 报 `unchanged/changed/missing/not_checkable`
- [x] 可见性治理：**三级 allow/deny**（connection/server/tool，deny 永远赢）+ **契约层联动 + 执行面闸**
- [x] 导入导出：脱敏导出（MCP `config: null`）+ 幂等导入 + 逐条报告
- [x] 前端：能力清单页、来源页、可见性治理页（viewer 可读，写操作按矩阵收敛）

### 验收标准（实测结果）

| # | 标准 | 实测 |
|---|---|---|
| 1 | 关可见性后契约层 `listTools` 立即不含它 | ✅ `applyCapabilityGate` 套 provider：停用/deny 的工具现查库剔除（`blocked` 带原因），test-governance 直接断言 `kernel.provider.listTools()`（不看 UI）；**执行面同闸**：`tool_not_visible` 403 + 审计 denied |
| 2 | 治理规则以数据形式存在，可导出可 diff | ✅ 三级绑定 = `capability_bindings` 数据行；`GET /api/capability/policies` 与 `export` 都能整表导出；判定语义（deny 永远赢）由纯函数 + 穷举测试钉死 |
| 3 | 安装失败不落半成品 | ✅ 好包真落盘；坏 ZIP / 路径穿越包 → 400 + 审计 `capability.skill.install`(denied) + `caps.unregisterSkill` 回滚，回归断言注册表里无残留 |
| 4 | 脱敏导出不含凭据明文 | ✅ 导出对 MCP 一律 `config: null`（测试逐条断言）；导入端如实标注「需补配连接信息」；`audit-layering` 断言产品层无凭据词汇泄漏 |

**实施中修掉的真实缺陷**：
1. **`setBinding` 的 ON CONFLICT 陷阱** —— 表上无业务键唯一约束，`ON CONFLICT ... WHERE` 的 upsert 永远插新行造成重复绑定。改两步读改写（迁移只增不改，不回头补索引；单写者模型下安全）。
2. **多租户与契约层的语义张力** —— 契约层 `listTools` 不带租户概念，per-tenant 精确可见性做不到而不说就会变成越权泄漏。采用**保守并集**（任一租户 deny 即从契约层剔除）并写进注释与文档，精确隔离顺延 M5（契约带租户后）。
3. **测试假设错位两例** —— ① 假设 viewer 应对能力清单 403，实际 `ROLE_MATRIX` 自 M1 起显式授予只读 read（改测试不改矩阵）；② skills 响应形状断言写成 `kernel.tools`（实际 `kernel.skills`）。
4. **test-frontend 垫片缺浏览器 API** —— `URL.createObjectURL` / `Blob` 在 vm 沙箱里不存在，导出下载抛错连带「无可见反馈」假失败。垫片补齐（真实浏览器不受影响）。

---

## M5 · 企业化收口（0.6.0 ✅）

### 交付物

- [x] 多租户隔离审计：**静态扫描** `tools/audit-tenant-isolation.mjs`（隔离表清单从迁移事实生成，非手写；84 条触碰隔离表的 SQL 逐一核验 `tenant_id`，动态 WHERE 显式豁免带理由）+ **双租户动态用例**（审计/会话执行/产物/绑定四路跨租户 404 或空集）
- [x] 备份 / 恢复：`POST /api/operation/backup`（`VACUUM INTO` 在线一致性快照 + storage 打包 + manifest 逐文件 SHA256）+ `POST /api/operation/backup/verify` + **离线恢复** `tools/restore-backup.mjs`（防误覆盖 + 恢复后 `integrity_check` 自证）。**诚实边界：恢复刻意不做在线接口** —— 服务进程握着打开的库句柄，运行中换库不是"危险"两个字能概括的
- [x] per-tenant 可见性（M4 顺延）：`listTools({ tenantId })` 两档语义 —— 带租户精确判定 / 不带租户保守并集（gatedBy 如实标注）。顺带修掉真缺陷：tenant 级绑定落库 `subject_id` 存了空串，保守并集看不出、精确判定立刻暴露
- [ ] SSO / LDAP：**如实不实装**（0.5.0 与 0.6.0 均无目标客户环境可对接，做了就是无验收标准的猜谜）。
  ⚠️ **2026-10-01 复核更正**：原文此处写"表结构与登录链路预留仍在" —— **不实**。
  `users` 表是纯本地账号模型（`username` + `pwd_hash`/`pwd_salt`，无 `external_id`/`identity_provider` 字段），
  登录链路是 scrypt 本地口令 + 会话令牌、**无 provider 抽象**。接 SSO 属**新增字段 + 新增抽象**，不是"接线"。
  真实立项时按 `docs/deploy.md` 的凭据与审计纪律走。
- [x] 完整回归套件：八个脚本（core 102 / http 41 / knowledge 34 / frontend 37 / governance 46 + audit-layering + audit-tenant-isolation + pack-release 双扫描）
- [x] 打包：`tools/pack-release.mjs` —— 白名单制（想进包必须列在清单里）+ **打包即扫描**（条目名排除顶层 data/ 与 .db/.secret/.env；源码内容 3 条凭据特征扫描），产物 `dist/sti-harness-<版本>.zip`
- [x] 生产基线文档：`docs/deploy.md`（端口/反代/TLS 边界、备份与恢复、排障）—— M2 起持续维护，本版补备份章节
- [x] 升级与兼容策略：`docs/compatibility.md`（版本号单一真源、兼容/破坏判定表、迁移只增不改、标准升级五步、主密钥单独保管）

### 验收标准（实测结果）

| # | 标准 | 实测 |
|---|---|---|
| 1 | 备份 → 清库 → 恢复 → 回归通过 | ✅ test-governance 迷你闭环：在线备份 → 恢复到全新目录（防误覆盖生效）→ 只读连接 `integrity_check` ok + 关键表齐全 + orgs 行集逐行一致。篡改任一字节 → verify 精确指认被改文件 |
| 2 | 权限矩阵每角色每权限正反用例 | ✅ M1 起在 `test-core` 穷举（矩阵驱动，自动覆盖新增的 `operation` 资源）；端到端正反用例分散在 governance/http/frontend 各 section（如 viewer 无 operation:write → 403 + needs） |
| 3 | 打包产物 0 泄漏 | ✅ pack-release 双扫描：117 个条目中顶层 data/ 与 *.db/.secret/.env 零命中；app/ 源码 3 条凭据特征零命中。`DONE leaks=0` |
| 4 | 「部署到别人机器」说明 | ✅ `docs/deploy.md`（安装→初始化→凭据矩阵→反代→排障→备份恢复）+ `docs/compatibility.md`（升级五步 + 降级路径）|

**实施中修掉的真实缺陷**：
1. **tenant 级绑定的 `subject_id` 存了空串** —— M4 的保守并集判定读全表不看 subject，掩盖了这个问题；M5 的 per-tenant 精确判定第一天就暴露。修：落库时 tenant 级绑定 `subjectId` 默认取租户 id。
2. **`setBinding` 按行 id 读改写不带 tenant_id** —— 全局 id 无越权可能，但纵深防御照补；静态扫描抓的就是这一类。
3. **扫描器三层容错**（SQL 语法位置的表引用 / 代码语句级拼接扩展 / 带理由的豁免标记）—— 第一版 16 条"违规"里 10 条是误报（URL、注释文本、跨字面量拼接），不修容错，扫描器自己先变成狼来了。

---

## P0 · 运行时打通（0.6.0 之后 · ✅ 已完成 2026-10-01）

> **为什么 0.6.0 之后还有 P0**：0.6.0 交付时，**所有回归都在 mock 内核下跑**，
> 因此"真实内核下建会话/发回合全部 501"这种事没有任何脚本能发现。
> mock 绿只能证明治理层没问题，**不能证明平台能用**。
> 详见 [`history/assessment-0.6.0.md`](history/assessment-0.6.0.md)。

### P0-A · 接通真实内核 ✅ 已完成（2026-10-01）

- [x] `tools/verify-upstream.mjs` —— 对**运行中**的 DSH 逐条实测：先探方法存在性，
      再跑真实会话生命周期（建会话→改名→选模型→发一轮→技能→取消→分叉→归档），
      输出可直接抄进垫片的结论
- [x] `compat/0.2.0-rc.2.mjs` —— **动态核实**的垫片（区分「RPC 已核实」「部分核实」
      「来自事件流非 RPC」，并留档 9 个已证伪的历史方法名）
- [x] `compat/index.mjs` —— 按上游版本选垫片；版本对不上时**如实告警**，不静默用错
- [x] `sessionlog.mjs` —— 历史/增量读上游 append-only 会话日志（拼接 zstd 帧容器）
- [x] `tools/test-external.mjs` —— 外部模式端到端回归（12 用例；上游不在场则如实 SKIP）
- [x] `config.mjs` 版本矩阵纳入 `0.2.0-rc.2`；`versionGate` 文案更正

**验收实测**：`node tools/test-external.mjs` → 12 用例全过，核心断言输出
`事件 17 条，类型：lifecycle turn-start message turn-end`。
mock 侧 260 用例同时全绿 —— **两条路径都回归**。

### P0-D · 0.6.0 遗留小缺陷 ✅ 已完成（2026-10-01）

> 每一项都要求**有回归钉住**——修完不钉，等于下次改回去没人知道。

- [x] `versionGate` 警告文案（原称"尚未交付 fixtures 回归"，M0 已交付）
- [x] `test-core` 版本门禁用例不再写死"越界版本"字面量（改为**构造**一个必不在矩阵内的版本）
- [x] `config.sessionTtlHours` 死配置 → 换算收口到纯函数 `config.sessionTtlMs()`，装配层接线。
      钉住：`test-core` 4 条（换算边界 / 默认配置 / **装配层真的调用**（源码级断言）/ 服务层
      `sessionTtlMs` 真的决定 `expiresAt` 的端到端闭环）
- [x] `approvals` 表补 `tenant_id`（**这是一处真实的静默越权**，不只是"为了整齐"）：
      0006 增量迁移（加列 + 从 session 回填 + 索引）；审批门的三条查询、`decide()`、
      `getById()` 全部强制带租户；跨租户 id 一律按"不存在"处理（不泄漏存在性）。
      钉住：`test-governance` 跨租户用例（各自建单 / 队列不混 / 跨租户决定 404 /
      **org2 不得借用 org1 的批准单**）+ `audit-tenant-isolation` 静态扫描 0 违规
- [x] 前端 `PLANNED` 不再把已交付的 M5 列为"尚未交付"（空表 + 显式出口保留）
- [x] 前端补备份页（`/api/operation/backup*` 原本无 UI）：列表 / 创建 / 校验三件事都通，
      并为列表补了一条**只读**的 `GET /api/operation/backup`（没有它只能盲打文件名）。
      **刻意不做"删除备份"接口**：删备份不可逆，交给运维在文件系统里做。
      钉住：`test-governance`（列表形状 + viewer 403）+ `test-frontend` 2 条（渲染/动作真实发请求 + 权限收敛）
- [x] 安全响应头（CSP / HSTS / `X-Frame-Options` / `X-Content-Type-Options` / `Referrer-Policy`）：
      新增 `app/http/security-headers.mjs`，在请求入口一次性 `setHeader`（API/静态/透传全覆盖）。
      诚实边界：CSP 带 `'unsafe-inline'`（前端大量内联事件属性，去掉需另一轮重构）；
      **HSTS 只在 HTTPS 下发**（明文发无效且误导"已上 TLS"）。
      > ✅ **后续（0.9.0 / P1-3 · 3.4）已去掉 `script-src` 的 `'unsafe-inline'`**：内联事件属性改事件委托、
      > 首屏脚本外链。`style-src` 的 `'unsafe-inline'` 仍保留（123 处内联样式属性，理由见 §P1-3）。
      钉住：`test-core` 2 条纯函数 + `test-http` 1 条端到端（API 与静态页都要带）
- [x] README / `audit.mjs` 关于「链尾外发」的陈述更正：M5 **已交付但没有做**这件事，
      不是"M5 会做"（属 P1 backlog，如实标注）
- [x] **#8 · 补 `groups` / `group_members` 两表，让"组级角色绑定"真落地。**
      原缺陷不是"少了张表"，而是**一处静默空转**：`role_bindings.subject_type` 的注释写着 `-- user | group`，
      却没有 `groups` 表 —— 调用方按注释绑一个组 id，会拿到 `{ok:true}` 且**真的写进库**，但权限判定只看
      `subject_type='user'`，于是这些绑定永远读不到、也不报任何错。**等于承认了一种主体类型却无法表达它。**
      修法：生效角色改为**并集** `直接绑定(user) ∪ 所属组绑定(group)`；认证路径（`authenticate` / `login` /
      `publicUser`）每次都把组带来的角色一并带出，否则 RBAC 层看不见。同时加固四处：
      ① `bindRole` 校验「主体 org == 角色 org」（否则拿到别家 id 就能把别家身份绑到本组织角色上，**跨租户提权**）；
      ② `addMember` 校验成员属于本组织；③ owner 保护**穿透组**（`countHolders` 数的是**生效**用户，
      `countActiveHolders` 只数 `status='active'` —— 停用账号不改任何绑定，"数绑定"看不出问题）；
      ④ 批量 `roleKeysForUsers` / `groupsForUsers`（列表页 N+1 优化）与逐个版**逐格一致**，
      批量版的组分支从 `group_members` 取 `user_id`（写成 `b.subject_id` 会把组 id 当用户 id，键对不上就静默丢角色）。
      **诚实边界**：`groups` / `group_members` 沿用身份模块的 `org_id` 命名而非 `tenant_id`，
      因此 `audit-tenant-isolation` 的静态扫描**不覆盖**这两张表（隔离表清单取自迁移事实）。补偿取最强一层 ——
      `test-governance` 的跨租户动态用例。
      钉住：`test-core` 6 条（组角色真的生效含认证路径 / owner 保护穿透组：摘角色·移成员·删组均整体回滚 /
      跨组织拒绝 / 未知 `subjectType` 拒绝 / 批量=逐个 / permissions 矩阵新增 `group` 资源）
      + `test-http` 3 条端到端（组角色经 **HTTP 认证路径**生效 / 列表·详情·未知组 404 / 路由表登记 7 条接口）
      + `test-frontend` 5 条（组页渲染 / 成员从账号反查 / 四个动作真发请求 / 未知账号不发请求 / 权限收敛）。
- [x] **#9 · `operation` 模块补 `service.mjs` 门面。**
      原缺陷：五个平台模块里**唯一没有门面**的一个，且"备份目录列举 / 文件名合法性校验"等业务逻辑长在路由层，
      违反「路由只做 解析 → 调服务 → 响应」的分层纪律。
      修法：新增 `createOperationService({ dataDir })` 并下沉逻辑。`resolveBackup` 成为**唯一路径校验点**
      （拒绝 `/`、`\`、`..`），并把「文件名非法（400）」与「文件不存在（404）」**分开报告**；
      `verifyByName` 回 `{ok:true, name, verdict}` 的**两层结论** —— 合并成一个 `ok` 就分不出"404"与"200+问题清单"。
      刻意**不暴露 `restoreBackup`**：一个不存在的入口，比一个存在但请勿调用的入口安全得多。
      路由加 fail-fast 装配守卫（少给 `deps.operation` 直接抛错，不让多条路由静默失效）。
      钉住：`test-core` 4 条（分层断言：路由不 import `node:fs` / `main.mjs` 真的装配 / `verifyByName` 两层结论 /
      门面形状）+ 各回归脚本装配补 `createOperationService` + `audit-layering` 0 泄漏。

### P0-C · 回合流式化 ✅ 已完成（2026-10-01）

服务端增量推送 + 前端逐字渲染。

- [x] transport 选型：**POST + 分块响应（NDJSON）**，不用 WS（`node:http` 无自有 WS 服务端，
      双工用不上）、不用 SSE/`EventSource`（只支持 GET，而提交回合必须 POST）。
      每行一个 JSON 帧，`kind` 决定类型：`meta` / `turn` / `event` / `warning` / `done` / `error` / `ping`。
- [x] `app/http/stream.mjs`：零依赖 NDJSON 流助手（心跳、`x-accel-buffering: no`、
      `socket.setNoDelay(true)`、close 幂等）。**关键约束**：一旦开流写出 200，状态码锁死 ——
      因此"会话校验 / content 非空 / 配额闸"等需要回 4xx 的步骤必须在开流**之前**完成。
- [x] `runTurn()` 单一实现：非流式 `/turns` 与流式 `/turns/stream` 共用同一函数，
      保证"配额口径、用量采集、产物提取"只有一份真相。
- [x] mock 可观测节奏 `STI_MOCK_PACE_MS`（默认 2ms，首条立即吐）—— 否则"首字先到"无从观测。
- [x] 回归：`test-stream`（22 用例）+ `test-external-stream`（需真上游，缺则如实 SKIP）
- **验收实测（真实上游）**：`事件 17 条｜4 个分块｜首事件 +237ms｜收流 +646ms`
      —— 证明"首字即达"不是自造假象。

### P0-B · 用户对话工作台 ✅ 已完成（2026-10-01）

新增与后台**并存**的「工作台」壳：左会话列表 / 中对话流 / 右上下文与工具。
含工具卡、内联审批卡、模型切换。首个路由项即工作台（最终用户打开就是对话框，
无 `session:read` 才退回概览）。

- 局部重绘：聊天不能走后台的整页 `render()`（会重置输入框/滚动/展开态），
  改用 `wbPaint()` 只更新 `#wb-stream`；`wbEnsureLoaded()` 带 `loaded/loading` 双闸防死循环。
- 流式解析：`fetch().body.getReader()` 逐块读 NDJSON（退化路径为 `res.text()`）。
- 回归：`test-frontend` 工作台 7 用例（落地页 / 历史回放 / 模型目录 / 逐帧解析 /
  viewer 只读 / 权限收敛 / 流失败只影响单条消息）。

### P1 · 企业级补齐（backlog，P0 之后的下一批）

> 📌 **本 backlog 已被 [`history/assessment-0.7.0.md`](history/assessment-0.7.0.md) 全量重排**（2026-10-01 大检查）。
> 那份材料把"该完善什么 / 该新增什么 / **明确不该加什么**"逐项列清，并给出依赖优先的施工顺序。
> 下面 1-4 项是其中的一部分（1 已交付）；新增项以那份材料为准。

1. **模型中心**：平台侧多 provider 配置 + 连通性测试 + 默认模型/降级链。✅ **已于 0.7.0 交付**（见下）
2. **审计保留与链尾锚定**：保留期策略 + 每日链尾 hash 外发（解决"整表重写"边界）。✅ **已于 0.8.0 交付**（见 P1-2）
3. **配额并发闸**：`concurrent` 目前是 `unknownMetric`，补真闸。✅ **已于 0.8.0 交付**（见 P1-2）
4. **CSP 去 `unsafe-inline`**：内联事件属性改事件委托 + 外链脚本。（移入 P1-3，见 `history/assessment-0.7.0.md` §6.2 第 3 步）
5. **定时任务底座 / 出站通知 / 指标端点**：`history/assessment-0.7.0.md` 新增的 Tier-1 三件套。✅ **已于 0.8.0 交付**（见 P1-2）

### P1-1 · 模型中心 ✅ 已完成（0.7.0 · 2026-10-01）

> **交付边界（必须先说清）**：本项交付的是**配置 + 探活 + 排序**，
> **不做请求转发**。把配额从「事后统计」升级为「事前拦截」需要 model gateway 本体
> （必须挂在模型调用路径上），那是另一件事。这个边界在界面与接口里都显式写出，
> 否则「模型中心」四个字会被误读成「配额已经能事前拦了」。

- [x] 迁移 `0008_models.sql`：`model_providers` 表（带 `tenant_id`，被 `audit-tenant-isolation` 覆盖）+
      `idx_model_providers_tenant` + `idx_model_providers_default`
      （**部分唯一索引** `ON model_providers(tenant_id, kind) WHERE is_default = 1`）。
- [x] `app/platform/model/probe.mjs`：`PROTOCOLS_BY_KIND` / `endpointFor(kind, protocol, baseUrl)` / `probeModel(cfg)`。
      真出网（对话探活发 `max_tokens:1`，结论带 `billedRequest: true`），不做「只探端口」的假探活。
      向量探活**复用** `createEmbeddingProvider(...).health()`，与真实导入共用同一实现。
- [x] `app/platform/model/service.mjs`：`createModelService({ resolveCredential, probeTimeoutMs })` ——
      11 个方法（list/get/create/update/delete/setEnabled/setDefault/resolveChain/resolveDefault/probeProvider/resolveEmbeddingForIdentity）。
- [x] `app/http/routes/model.mjs`：9 条路由（`model.providers.list/create/get/update/delete` + `enabled` + `default` + `probe` + `model.chain`），全带审计；
      权限 `model:read/write/delete`（admin 全权，member/viewer 只读）。
- [x] 装配：`app/main.mjs` 提出具名 `resolveCredential` 供模型中心与知识层共用；`createModelService` **先于**知识服务装配。
- [x] 前端「模型中心」页（`public/app.js`：`pageModels()` + 6 个动作 + 用途/协议选择器 + 默认来源标注）。
- [x] 回归钉住：`test-core` +9（127）、`test-http` +4（49）、`test-frontend` +6（59，录制 69）；其余脚本装配补 `model`。

**实施中的关键设计判断**：

1. **降级链 = 同 kind 内按 `priority` 升序的启用项序列**，不另建链表 —— 多一张链表就要维护「链与项一致」，而顺序在 `priority` 一列里已完整。
2. **默认唯一性由库层部分唯一索引保证** —— 服务层漏清旧默认会被库层直接拒绝，而不是留下两个默认让结果取决于行序。
3. **`defaultSource` 三态**：`'explicit'`（有人显式设）/ `'chain-head'`（没设默认，取链首）/ `null`（该用途无启用项）。不区分就无法在界面上诚实显示默认是从哪来的。
4. **探活两层结论**（与 `operation.verifyByName` 同纪律）：`ok` 说「这次调用有没有跑成」，`verdict` 说「连通性结论」。合并成一个 `ok` 就分不出「条目不存在(404)」与「条目存在但连不上(200+结论)」。
5. **`level:'skipped'` 与 `ok:true` 同现**：表示「这条没配，是预期状态」（向量协议 `none`），与「配了但连不上」(`level:'fail'`) 严格区分。
6. **失败分类**：`timeout` / `unreachable` / `auth_rejected` / `not_found` / `rate_limited` / `http_error` / `not_configured` / `bad_protocol` / `bad_kind`。笼统的「探活失败」让运维无从下手。
7. **密钥只有名称出口**：表存 `credential_name`（凭据**名**），值在 credentials 表 AES-256-GCM 加密；公开形状只出名称与 `hasCredential`。
8. **停用默认项是单向的**：停用当前默认项会撤掉默认标记，**重新启用不会自动恢复默认** —— 必须显式回报（`clearedDefault` + `note`），否则「关一下再开一下」会静默换默认。**删除默认项也不自动提升下一个**（悄悄改行为比报个提示危险）。
9. **模型中心 → 知识层接缝**：`resolveEmbeddingForIdentity(tenantId)` 返回默认向量项配置；知识层 `embeddingConfig` 优先读注册表，返回 null 时回落 `config.json`，并在描述里标 `source: 'model-registry' | 'config'`。没有这个接缝，模型中心就只是「能存能看的表」，与检索质量脱节。
   **端到端验证**：登记前 `embedding.mode=none source=config`；登记一条默认向量条目后 `embedding.mode=openai-compat source=model-registry registryName=接缝向量` —— 证明「页面配的模型」与「检索真正用的模型」是同一份。


### P1-2 · 治理闭环与运维底座 ✅ 已完成（0.8.0 · 2026-10-01）

> 📌 本批严格按 [`history/assessment-0.7.0.md`](history/assessment-0.7.0.md) §6.2 的施工顺序执行：
> **第 1 步（Tier-1 三件套：定时底座 / 出站通知 / 指标）→ 第 2 步（合规与闭环硬项：
> 审批超时 / 审计保留归档锚定 / 并发真闸 / 知识重试+重新向量化）**。
> 第 3、4 步（OpenAPI、成本核算、CSP、工作台最后一公里、库级 ACL、定期备份、服务账号、
> 数据主体权利、SSO）留待 P1-3，依据同一份材料的依赖顺序推进。

**第 1 步 · 运维底座（收益最广，解锁后面所有"按时间跑"的能力）**

- [x] 迁移 `0009_ops.sql`：`scheduled_jobs` / `notify_channels` / `audit_anchors` / `audit_chain_state`
      四张表（全带 `tenant_id`，隔离扫描表 13 → **17** 张）。
- [x] `app/platform/schedule/tasks.mjs`：**执行体白名单**（`TASK_DEFAULTS` / `TASK_KINDS` / `TASK_INFO`
      / `runTask`）。5 个 kind：`approval.expire`、`audit.archive`、`audit.anchor`、`backup.create`、`model.probe`。
- [x] `app/platform/schedule/service.mjs`：`parseSchedule` / `computeNextRun` / `describeSchedule`（纯函数，UTC）
      + 任务 CRUD + `tick()`（重入保护）+ `start/stop` + `ensureDefaults*`。
- [x] `app/platform/notify/service.mjs`：`NOTIFY_EVENTS`（5 个）/ `SINK_KINDS` / `assertSafeTarget`（异步，含 DNS 解析）
      / `assertScheme`（同步，写入路径用）+ 渠道 CRUD + `emit` + `testChannel`。
- [x] `app/platform/observe/metrics.mjs`：计数器 / 直方图（11 个桶）/ 在途 gauge + Prometheus 文本渲染。
- [x] `app/http/routes/schedule.mjs`（6 条）+ `notify.mjs`（5 条）+ `system.metrics`（1 条）；权限加
      `schedule` / `notify` 两个资源（**只有 admin/owner 有**，member/viewer 一律 403）。

**第 2 步 · 合规与闭环硬项**

- [x] **审批超时（消灭 `expired` 死状态）**：`approvals.expireStale({tenantId, ttlMs})` + `decide()` 的惰性超时。
      此前 `pending` 单只能由人处理，发起方回合**永久挂起**。
- [x] **审计保留 + 归档 + 链尾锚定**：`audit.archive()` / `audit.anchor()` / `chainInfo()` /
      `DEFAULT_RETENTION_DAYS=90`。**关键正确性修复见下**。
- [x] **`concurrent` 真闸**：`app/platform/governance/concurrency.mjs`（内存计数）+
      `quotas.enterConcurrent()`（**原子**判定+入场）+ `withTurnGate` 挂在两条回合路由上。
- [x] **知识重试 + 重新向量化**：`reprocessDocument` / `retryDocument` / `reindexBase` /
      `embeddingConsistency`；迁移 `0010` 给 `documents` 加 `embedding_provider/model/dim`。
- [x] 前端两页：**调度中心**（`pageSchedules`）+ **通知渠道**（`pageNotify`），各 5 个动作。
- [x] 回归钉住：`test-core` +12（**140**）、`test-http` +8（**57**）、`test-frontend` +7（**66**，录制 **84**）。

**实施中的关键设计判断**

1. **归档会破坏朴素实现的哈希链 —— 这是本批发现的唯一"正确性缺陷"（不是功能新增）。**
   链每行记 `prev_hash`，校验从 `prev=''` 起算。按保留期删掉最旧若干行后，剩余第一条的
   `prev_hash` 指向已删除的行，校验会在第 0 行**误报断裂** —— 报出来的"首个断裂点"是假的，
   最坏的结果是让人**不再信这条链**。修法：引入链基准 `audit_chain_state.base_hash`
   （write 无行时用它当 prev、verify 从它起算并**回报 base**、archive 在同一事务里删行+更新基准）。
2. **先落盘、后删除**：归档文件写失败则**一条都不删**。"删了但没存下"是不可逆的数据丢失，
   而"存下了没删"只是下次再来一遍。这个顺序不能反。
3. **归档动作本身入链**：否则"谁清掉了哪些行"没有任何痕迹 —— 那正是审计最该回答的问题。
4. **链尾锚点只有离开本机才有意义**：落文件 + 落表只是便于展示，防不住"有库权限的人连锚点一起改"。
   因此锚点必须同时报 `tailHash` **与** `baseHash`（只给链尾等于只给一半信息，无法判断是否被从头部截断），
   并可选通过 `notify` 事件 `audit.anchor` 出站。
5. **调度器不是 cron**：只认 `interval:<毫秒>` 与 `dailyAt:HH:MM`（按 **UTC** 解释，与 `usage.periodStart()` 同口径）。
   一套 cron + 时区 + DST 是独立的复杂度来源，而 90% 诉求两种规则就够。**非法规则在写入时即拒绝** ——
   落库一个解析不了的规则，之后每一轮扫描都会静默跳过它，那是最坏的形态。
6. **不补跑错过的任务**：进程停了就没有调度。"补跑一次归档"与"补跑一次备份"风险完全不同，
   让调度器统一猜是错的。这条边界写进 `status.boundaries` 并显示在页面上。
7. **执行体是白名单，不是动态 `import(kind)`**：动态 import 一个来自数据库的字符串
   等于把"库写入权"升级成**任意代码执行**。白名单还让"库里有个没实现的 kind"变成一条**如实
   的 fail 记录**（`unknown-kind`），而不是静默跳过（静默跳过会让运维以为任务在跑）。
8. **投递尽力而为**（**0.8.0 时点的判断**）：最多 2 次 + 指数退避，失败入审计链，**不做持久化重试队列**。
   ⚠️ **这一条已在 0.11.1 修订**（体检 §B5，见下方"P1-2 补丁 · 通知失败重投队列"）：
   失败不再只留一条审计，而是**落 `notify_deliveries` 队列**、由定时任务 `notify.retry` 重投
   （最多 6 次，指数退避封顶 1 小时，超限转 `dead` 但**保留可见、可手动重投**）。
   原做法把"上游抖一下"直接变成"告警永久丢失"，而丢掉的恰恰是必须被看见的那几类事件。
   **修订后仍然成立的边界**：平台**整体停机**期间的告警照样会丢（单进程、无分布式锁），
   且语义是 **at-least-once**（接收方按 `X-STI-Delivery-Id` 去重）。
9. **SSRF 取舍（内网部署的刻意选择）**：**允许**内网地址（`10./172.16-31./192.168.`，webhook 目标常在内网），
   **拒绝**回环（`127.0.0.0/8`、`::1`、`::`）、未指定（`0.0.0.0/8`）、链路本地含云元数据（`169.254.0.0/16`、`fe80:`）。
   一律禁私网等于把功能做废；一律放行等于把 SSRF 送给内网。**连接前把主机名解析成 IP 逐一校验** ——
   只校验字面量会被"解析到 `127.0.0.1` 的域名"绕过。
10. **URL 加密与"只回显 host"**：出站 URL 常内嵌机器人 token（`?access_token=`），它**等价于一个密钥**。
    `shape()` 只回 host（连 query 都不给）；无加解密装配时**拒绝以明文落库**（红线，不是"能降级就降级"）。
11. **并发闸可以做了 —— 因为前置条件变了，不是"终于挤时间做了"**：M3 时 `concurrent` 留作未实装，
    因为航线图还留着"横向扩展"的可能，那时内存计数只是临时方案（多实例各数各的必然出错）。
    到 P1-2，「单进程」已是**架构承诺**（`architecture.md` §10.1），内存计数从临时方案变成正确答案。
12. **并发判定与计数必须原子**：不能"先 `evaluate` 再 `enter`"（两步间有窗口，两请求可双双冲破上限）。
    `enterConcurrent` 把判定 + 自增收在一个同步函数里；`enter/leave` 必须成对（`finally`），
    泄漏的表现是"没人用却报并发超限"。
13. **`withTurnGate` 放在路由层，且流式路由必须在开流之前判**：开流后状态码锁死 200，拿不到 429。
14. **metrics 无条件记录 vs 审计有条件记录**：审计只记状态变更（GET 成功不记，靠"少记"维持信噪比）；
    指标每请求都记（靠"一个不漏"算 rate）。因此 `finalizeMetrics` 是**另一个**函数，不塞进 `finalizeAudit`。
    一个直接后果写在用例里：**本次请求不在它自己的指标响应体里**，且 401 也必须计数（漏掉失败会让成功率曲线系统性偏好）。
15. **`/metrics` 走 session + `system:read`**（不是 public）：它含本组织审计链长；采集器用只读账号 API Key。
16. **向量一致性（迁移 0010）**：P1-1 让默认向量模型可在页面点击切换 → 出现"同库两种模型嵌入的向量
    混着做余弦比"的新状态，**数学算得出、语义无意义、且没有任何报错**（只是"变差"）。
    `documents.embedding_provider/model/dim` 记录每篇文档的向量来源，使其**可见**。
17. **知识重试/重建都要求原始文件还在**：粘贴文本导入（`sourceType='text'`）没有落盘原文 →
    如实报 `no_source_file`，不假装成功。

**回归与审计（0.8.0 实测）**

| 脚本 | 结果 |
|---|---|
| `test-core` | 用例 140 ｜ 失败 0 → `DONE fails=0` |
| `test-http` | 用例 57 ｜ 失败 0 → `DONE fails=0` |
| `test-knowledge` | 用例 34 ｜ 失败 0 → `DONE fails=0` |
| `test-governance` | 用例 48 ｜ 失败 0 → `DONE fails=0` |
| `test-stream` | 用例 22 ｜ 失败 0 → `DONE fails=0` |
| `test-frontend` | 用例 66 ｜ 录制 84 ｜ 失败 0 → `DONE fails=0` |
| `audit-layering` | `DONE fails=0` |
| `audit-tenant-isolation` | 隔离表 **17** 张 ｜ 语句 135 条 ｜ 违规 0 → `DONE violations=0` |
| `main.mjs --check` | 路由 **100** 条（public 8 / session 48 / admin 44）｜迁移 **0010**｜无阻塞问题 |

**前端回归抓出的两个真实缺陷（不是"加用例"，是"用例抓到了错"）**

1. **`loadSchedules` / `loadNotify` 漏了权限门禁**：其它 loader 都有
   `if (!allowed(...)) { ...; return; }`，这两个没有 → viewer 每次登录都会打出**两个注定 403 的请求**，
   页面看起来没坏，但服务端会把它记成"有人越权访问"，把审计信噪比搞坏。
2. **两个 loader 漏了 `render()`**：动作都是"先渲染忙碌态 → 等接口 → 写 `State.notice`"，
   少了这一句 `notice` 永远画不出来 —— 用户看到的是**"点了没反应"**。这类缺陷接口回归全绿也发现不了，
   只有真的把 `app.js` 跑一遍（`test-frontend` 的 vm 回放）才会暴露。

**同类启发**：`test-http` 的"通知渠道"用例最初断言 `ftp://` 应被 400 拒绝 —— 结果是它被**放行**了。
这说明当时只在**投递时**做 scheme 校验。于是把静态部分抽成同步的 `assertScheme()` 并接到**写入路径**上
（与"非法调度规则写入时即拒绝"同一条纪律）：否则库里会静默存下一条**永远发不出去的渠道**，
运维要等到第一次真的该收到告警时才发现 —— 那时信息已经丢了。

### P1-2 补丁 · 通知失败重投队列（0.11.1）

> 📌 来源：`docs/assessment-0.11.0.md` §B5。0.8.0 的"投递尽力而为、**不做持久化重试队列**"
> （见上方关键判断 #8）被判定为**告警可靠性上的真缺口**：上游抖一下 = 告警永久丢失，
> 而丢掉的恰恰是 `audit.anchor`（它的存在意义就是"把锚点带出这台机器"）与 `backup.failed` 这类**必须被看见**的事件。

- [x] 迁移 `0016_notify_deliveries.sql`：新表 `notify_deliveries` + `(status, next_retry_at)` 与
      `(tenant_id, created_at DESC)` 两个索引。**只增不改**（不动历史迁移 —— 改它会断校验和、卡死启动）。
- [x] `notify.enqueueFailure()`：真事件的失败投递落队（`status='pending'`，首次重投排在 10 分钟后）。
      **试发失败不入队** —— 那是人在旁边看着的动作，丢进队列只会污染"待处理告警"这个数。
- [x] `notify.retryPending({ tenantId, limit, now })`：按 `next_retry_at` 取到期记录重投，
      **指数退避**（10 分钟起、×2、封顶 1 小时），最多 **6 次**，超限转 `dead`（**保留可见、可手动重投**，不是删除）。
      `now` 可注入 → 回归不必真的等 10 分钟。
- [x] `notify.redeliverNow()` / `notify.purgeDeliveries()`：手动重投（**死信可复活**，不受上限与到期时间约束）
      与终态清理。清理**只删 `delivered`/`dead`** —— `pending` 是"还欠着一条告警"，任何情况下都不删。
- [x] 定时任务 `notify.retry`（`interval:600000`，**随默认任务播种**）+ `TASK_INFO` 条目；
      任务状态语义：到期 0 → `skipped`，有重投（含"上游还是不通"）→ `ok`，**只有本次出现新死信才记 `fail`**。
- [x] 路由 `GET /api/notify/deliveries`（`notify:read`）与 `POST /api/notify/deliveries/:id/redeliver`（`notify:write`）；
      清单带回 `policy` 与 `queue`（页面的"待重投 N 条"就是 `queue.pending`）。
- [x] 前端：通知页新增**投递失败队列**面板（摘要 + 待重投/已放弃列表 + 「立即重投」）。
- [x] 回归钉住：`test-core` +10（**213**）、`test-http` +2（**77**）、`test-frontend` +1（**97**，录制 **109**）。

**四条设计判断（都不是"顺手"，写下来免得将来被改回去）**

1. **at-least-once，不是 exactly-once。** 重投时接收方**可能收到重复**。平台唯一能做对的事是：
   让同一条投递的**首次尝试与所有重投共用一个** `X-STI-Delivery-Id`，把去重交给最清楚语义的一方（接收方）。
   "确认对方只处理了一次"是分布式事务的范畴，不在这一层承诺 —— 写在响应里，不只写在文档里。
2. **`attempts` 只记"已被重投的次数"，从 0 起。** 不把首次投递内联的 2 次尝试算进去：
   否则 `attempts` 一诞生就是 2，上限 6 会被提前吃掉、实际只重投 4 次 —— 那是页面与实现不一致里最难发现的一类。
   内联次数是**策略常量**，不是每条记录的属性。
3. **渠道被停用 / 被删除时"不消耗重投次数"**：那不是"对方拒绝"，是"现在不该发"。
   若照常计数，"先把渠道停掉、修好再启用"这个很常见的动作会在 6 次之后把记录打成死信 —— 而它并不表示送不出去。
   这种情况下保持 `pending`、`next_retry_at` 照排，`last_error` 如实写明原因。
4. **重投前重新解密 URL、重新做 SSRF 校验**（`deliverTo` 内部每次做），**绝不缓存首次解析出的 IP**：
   主机名解析结果会变（DNS 重绑定），只在写入时判一次等于把安全边界钉死在过去。

**仍然成立的边界**（没变，但要说清楚别读错了）：平台**整体停机期间**的告警照样会丢 ——
队列是**本机单进程**的重投（与调度器同一约束：无分布式锁）。变的只是**"上游抖动不再等于告警丢失"**。

### P1-3 · 集成与体验（已收口 · 0.9.0）

> 📌 按 [`history/assessment-0.7.0.md`](history/assessment-0.7.0.md) §6.2 第 3 步推进：
> **4.5 OpenAPI 导出 → 4.4 成本核算 → 3.4 CSP 去 `unsafe-inline` → 3.6 工作台最后一公里**。
> **四项全部完成。** 第 4 步按客户触发再启动；
> 3.4 的另一半（`style-src` 去内联样式属性）明确保留，理由见下。
>
> 📌 **0.10.2 已先行补上「定期备份」的保留/轮转这一半**：`backup.create` 从 0.8.0 起就会按时间
> 产出备份，但**只增不减** —— 磁盘无界增长会让单进程服务直接挂掉。现在 `keep` 参数（默认 30 份）
> 给了它硬边界、删除入审计、且**没有 HTTP 删除入口**。第 4 步里**只剩「把备份任务默认播种」**未做，
> 且**是有意不做**：备份是消耗型动作，"要不要默认占盘"归运维而非平台。
>
> 📌 **0.11.0 已补上「库级 ACL」**（4.6）：知识库从"租户级隔离"下沉到**库级**可见性。
> `knowledge_bases.visibility ∈ {tenant, restricted}`（**默认 `tenant`** → 升级后行为逐字不变）；
> 授权复用 `role_bindings` 的**既有预留**（`scope_type='knowledge_base'` + `scope_id`，**零新表**，
> 迁移只 ADD COLUMN）；判定复用权限矩阵的 `can()`（有效角色 = 全局角色 ∪ 库级角色，
> **并集只作用于本库**）。三条安全线：**不可见按 404 处理**（不确认存在性）、
> **管理员对受限库恒可见**（防自锁）、**库级授权只能放宽被授权的那个库**。
> ⚠️ **库级授权的界面入口当时未做**（后端接口 + 回归已就绪，界面当时排在 0.11.1 之后）
> —— **已在 0.12.0 补上**：知识库页的「库级授权」面板（列名单 / 授权 / 撤权）。
> 第 4 步里**只剩服务账号 / 数据主体权利 / SSO** 按客户触发。

**4.5 · OpenAPI 规格导出 ✅ 已完成**

- [x] `app/http/openapi.mjs`：`buildOpenApi({ routes, version })` —— **从路由表生成**，不手写。
- [x] `system.openapi`（`GET /api/system/openapi.json`，session + `system:read`），
      **刻意不套平台 `{ok:true,...}` 信封** —— 套上就不是合法 OpenAPI，Swagger UI / Postman 全都吃不了。
- [x] 诚实边界写在规格自己身上（`info.description`）：**不是逐字段契约**（平台用运行时校验，
      没有可导出的静态 schema）。一份**编造字段**的规格比"没有规格"更危险 —— 没人敢信比没有更糟。
- [x] 回归钉住（`test-core` 2 条 / `test-http` 1 条）：`:id → {id}`、`x-sti-capability`、`public` 的
      `security: []`、`2XX` 区间（不是硬编 200）、`404` 只对带路径参数的接口声明、
      反转 routes 顺序后 `JSON.stringify` **逐字节相同**（注册顺序不进规格）。

**4.4 · 成本核算（token → 金额）✅ 已完成**

- [x] 迁移 `0011_model_prices.sql`：`model_providers` 加 `currency` + 四个 `price_*_minor`（可 NULL）。
- [x] `app/platform/governance/cost.mjs`：`computeCost` / `buildCostReport` / `summarizeCost` / `formatAmount`。
- [x] **归因链路打通**（这是它能不能用的关键）：`agent_sessions.model_provider/model_id`
      → `usage_records.model_id`（`recordFromEvents` 新增 `modelId`）→ 按模型名匹配 `model_providers.model`。
      `POST /api/kernel/sessions/:id/model` 与建会话时的显式选择**都真的落库**（此前只是转给上游，本地不留痕）。
- [x] `governance.cost`（`GET /api/governance/cost`，session + `quota:read`），口径随数据一起返回。
- [x] 装配：`createGovernanceService({ resolveProviders })` —— governance **不认识** model，靠装配层注入。
- [x] 前端：配额页顶部成本面板（按币种合计 / 未归因桶 / 逐模型明细 / 口径逐条）；模型页新增**单价列**
      （内联 `<details>` 编辑器）；工作台新增「已登记模型 / 未登记模型」徽标。
- [x] 回归：`test-core` +5（147）、`test-http` +3（61）、`test-frontend` +7（73，录制 93）。

**3.4 · CSP 去 `unsafe-inline` ✅ 已完成**

- [x] **事件委托**：`public/app.js` 里 **76 个 `onclick` + 2 个 `onchange` + 1 个 `location.hash` 导航**
      全部改成 `data-act` / `data-change` / `data-nav` 数据属性，监听器**只在 `document` 上挂一次**
      （`bindDelegates()`）。参数按位放 `data-a1` / `data-a2`，`act()` / `actCh()` / `navAttr()`
      三个小工具负责生成属性并 `esc()` 转义。
- [x] **首屏脚本外链**：`index.html` 里两段内联 `<script>`（主题上色 + `file://` 兜底）挪到
      `public/boot.js`，仍以阻塞式 `<script src>` 放在 `<head>`，因此**仍在首次绘制前执行**
      （暗色不会白闪）。`app/http/static.mjs` 的 `staticAssets()` 把 `boot.js` 纳入自检。
- [x] **CSP 收口**：`script-src 'self' 'unsafe-inline'` → **`script-src 'self'`**。
- [x] **回归**：`test-core` 安全头断言改为"script-src 必须无 unsafe-inline"；`test-http` 增加
      **端到端**断言（真实响应头的 script-src、`boot.js` 可取到、`index.html` 无内联脚本）；
      `test-frontend` +4（77）：静态"不得再有内联事件属性 / `javascript:` URI"+
      三条**真实派发**用例（`data-act` 参数原样到达含布尔还原与冒泡、`data-nav` 改 hash、`data-change` 传值）。

**3.4 实施中的关键设计判断**

1. **`javascript:` URI 也归 `script-src` 管** —— 这是个极易漏的点。页面里有 3 个
   `<a href="javascript:void(0)" onclick=...>`（知识库选库 / 分块 / 删文档）。只把 `onclick` 挪走、
   留着 `javascript:` href，这 3 个链接会**在浏览器里静默失效**（CSP 拦截不报错、页面也不报错，
   用户只看到"点了没反应"）。所以 `href` 一并改成 `href="#"`，由委托 `preventDefault()`。
2. **`style-src` 的 `unsafe-inline` 明确保留**：页面里还有 **123 处内联 `style="..."`**，
   而 CSP 里内联样式**属性**同样受 `style-src` 管辖。内联样式能造成的危害（样式注入、布局破坏）
   与内联脚本不在一个量级，为它做 123 处改写性价比很低 —— 因此**保留并在
   `security-headers.mjs` 注释里写明**，不假装已经去干净。
3. **只挪内联脚本 ≠ 前端变安全了**：真正的鉴权仍在服务端（`app.js` 文件头第 4 条）。
   这次改的是"XSS 的弹药供给"，不是"授权"。
4. **委托顺带消掉一类 bug**：监听器挂一次、不随重绘重绑 —— P1-2 那次"漏 `render()` 导致
   点了没反应"、以及"重绘丢监听"这类问题，在委托模型下从根上不存在了。
5. **布尔参数靠 `"true"/"false"` 还原**：属性值只能是字符串。本项目**需要布尔的参数只有"启停"一类**，
   其余字符串参数的取值里不会出现裸的 `true`/`false`，因此这个还原不产生歧义 —— 前提写进注释，
   避免以后有人往字符串参数里传 `"true"` 而踩坑。
6. **委托里的名字必须与 App 方法对账**：`act('名字')` 打错一个字母，表现是"那个按钮点了没反应"
   （比抛异常更难发现）。所以 `test-frontend` 会把 `act` / `actCh` 里的名字与 App 上真实存在的方法
   逐一对账（与原有的 `App.x(` 对账合并）。

**实施中的关键设计判断**

1. **没配单价是"不知道"，不是 0 元**：`amountMinor` 为 `null`。0 会被读成"免费调用"，
   算出一个偏低的、看起来完全正常的总额 —— 这是本项目最不能接受的一类错误。
   与之相对，**单价 0 是合法值**（真的免费），必须算成 `0` 而不是 `null`：两者在页面上的写法完全不同。
2. **缓存价不许用输入价顶替**：`cache_read` 常是输入价的 1/10、`cache_write` 常更贵。
   顶替产生的偏离方向取决于用量结构，外人无从判断对错 → 没配就记"未定价"。
3. **单价不追溯，也不快照**：金额每次按**当前单价**重算。所以页面上写"按当前单价估算"，
   并明确告知**改价会让历史用量的金额一起变**（要留证得先导出）。反过来把它说成"不改写历史"
   是错的，而且是那种听起来很合理、实则误导的错。
4. **金额全程整数运算**：`Σ(token × 单价)`，最后一步才 ÷ 1 000 000 并四舍五入。
   用浮点存金额迟早漂出 0.01 级误差，而那种误差没人能一眼看出来。
5. **归因不到不摊派**：`model_id` 匹配不到条目的用量进 `unattributed` 桶，**不拿默认模型的价去套**。
   同模型名有多条登记时按 `(priority, id)` 取第一条 —— 与降级链的选法一致，且结果**确定**（不依赖数组顺序）。
6. **不同币种分开合计**（`totalsByCurrency` + `mixedCurrency`）：把 CNY 与 USD 加在一起是个无意义的数，
   所以页面上**不做**"总额"卡片。
7. **成本单独一条路由、单独一份前端数据源**：不与 `/usage` 合流。usage 是客观 token 数（可逐字段对账），
   cost 是估算（依赖配置）。混在一个响应里，前端就分不清哪个能拿去对账。
8. **`usageRows` 必须区分"原始行"与"聚合行"**：`buildCostReport` 同时吃两种输入
   （原始 `usage_records` 行 / `GROUP BY model_id` 的结果，后者带 `COUNT(*) AS usageRows`）。
   不区分的话，聚合输入下"N 行用量"恒显示 1 —— 页面上就成了"每个模型只有一条记录"。
   这个 1 与真实的几万条差得很远，但错得不明显。**是回归用例把它抓出来的**（见下）。
9. **未选模型的会话写空串，不写"默认模型"**：建会话时刻意**不**自动填注册表里的默认对话模型 ——
   本平台不转发请求，无法保证上游真用了它。把平台的猜测写成"这个会话真的用了它"就是编造。
10. **`concurrent: '未实装'` 这类过期文案一并清掉**：P1-2 早已实装并发闸，但
    `governance.mjs` 的 `semantics.concurrent` 与 `quotas.mjs` 的注释还写着"未实装"。
    代码上线、文案没跟上是最典型的文档漂移 —— 而且它出现在**配额页的语义说明**里，
    是用户会直接读到的地方。顺手改成从 `semantics` 渲染（此前页面只写死 turns/token 两句，
    配了 `concurrent` 配额的人在页面上找不到任何解释）。

**回归抓出的真实缺陷（0.9.0）**

1. **`usageRows` 统计错**（`cost.mjs`）：未归因桶的"N 行用量"数的是**分组行数**而不是用量记录数，
   恒为 1。是 `test-core` 的端到端用例（写两条未归因记录、断言 `usageRows === 2`）抓出来的。
   修法：`rowsOf(r)` —— 有 `usageRows` 就用它，否则当 1（原始行）。
2. **工作台首次打开显示"未登记模型"**（`public/app.js`）：`wbRefreshContext()` 只在
   `wbPickSession` / `wbNewSession` 里调用，首次自动选中最近会话时**没有**调用 →
   徽标恒显示"未登记模型"。这是一句关于**成本归因**的错误结论（用户会以为用量不会被计到模型上）。
   是 `test-frontend` 的"已登记模型"用例抓出来的。
3. **配额页不渲染服务端语义**（`public/app.js`）：只写死 turns/token 两句，漏掉 `concurrent`。
   修：逐条渲染 `semantics`，并给每行配额补上 `note`。
4. **两条前端断言钉的是"旧标记"而不是"旧结论"**（`test-frontend`）：`onclick="App.wbSend()" disabled`
   与 `/App\.runSearch/` 在改事件委托后**必然失败**。这正是"断言 HTML 标记"的固有脆弱：
   要分开看它是**真结论**（"只读用户不该看到删除入口""无 `session:execute` 时发送按钮禁用"——
   必须保留，改到新标记 `data-act=...`）还是**实现细节**（用 `onclick` 还是 `data-act`——不该由用例规定）；
   前者改、后者删。三条断言都属前者，改到 `data-act` 后继续钉住同一个结论。
5. **自己写的注释把自己的断言搞挂了**：给 `index.html` 加的说明注释里含裸的 `<script>` 字样，
   让新加的"不得再有内联 `<script>`"静态断言**误报失败**。修：断言前先剥 HTML 注释。
   教训：**凡是扫描 HTML 的断言，都要先剥注释**，否则注释里的示例会变成假阳性
   （这类假阳性最坏的结果是"逼你改注释"而不是"漏掉真问题"，但会浪费判断力）。

**回归与审计**

> 三项交付时的实测是 147 / 61 / 77 / 34 / 48 / 22（合计 389）。
> 加上 3.6 之后的**最终实测**见本文末「回归与审计（0.9.0 收口实测）」。

**3.6 · 工作台最后一公里 ✅ 已完成**

交付四件事：**停止 / 重生成 / 附件 / 会话内搜索**。每一项都有一句"这是怎么做的、
边界在哪"的诚实说明，写在页面上，而不是只藏在文档里。

- [x] **停止**：`wbStop()` 做**两件事**——① `POST …/cancel` 带上本轮的 `turnId` 通知上游；
  ② 立刻 `abort` 本地读取。只做 ② 的"停止"是假的：界面停了、上游还在烧 token。
  取消接口**如实回报**是否成功（`upstream: {attempted, ok, error}`），失败时页面直说
  "上游可能仍在消耗 token，请以用量页数字为准"。审计动作 `kernel.session.cancel`（含 `turnId`）。
- [x] **重生成**：用**最后一条用户输入**再跑一轮。按钮的 `title` 写明**不撤销上一轮** ——
  已产生的用量、产物、审批记录都还在账上，重生成 = **再花一次钱**，不是"免费换个答案"。
  刻意**不复用**上一轮的附件勾选（静默复用会让人以为这一轮没引用它，而实际引用了）。
- [x] **附件**：迁移 `0012_session_attachments.sql` + `app/data/repositories/attachments.mjs` +
  4 条路由（上传 / 列表 / 下载 / 删除）。
  · **传输契约**：**元数据走 query，body 就是文件本身**（`POST …/attachments?filename=`），
  不用 multipart（理由见 `context.mjs` 的 `readRawBody`：手写一个"差不多能用"的 multipart
  解析器，出错方式是**静默截断或错位**，比不支持更糟）。
  · **文本 / 二进制按内容判定**（有 NUL 字节或非法 UTF-8 序列 → binary），**不看扩展名**。
  · **按内容分三条通路**（0.9.0 起，图片通路 0.10.0 补齐）：**图片**（PNG / JPEG / WebP / GIF，
  按**魔数**识别，不看扩展名）作为 `{type:'image'}` 内容块**真的送给模型**（本轮合计 ≤ 10MB）；
  **文本类**（≤ 64KB）正文拼成引用块**注入**本轮上下文（总量 ≤ 96KB）；**其余二进制**只登记/可下载，
  且**如实点名**（`attachments.skipped[]` 带 `reason` 与 `note`）—— 它们要走上游的
  **只读保存路径**通路（`fileUploads/upload`，B 档，**尚未接通**），**不是上游没有这个能力**；
  宁可少做，也不谎报"文件已交给模型"。
  · 上传上限 8MB，超限 **413 拒绝**而不是静默截断。
- [x] **会话内搜索**：`GET /api/kernel/sessions/:id/search?q=`。**放服务端**是因为
  工作台一次只回放最近 2000 条事件 —— 纯前端过滤会在长会话里给出"搜不到"的**错误结论**。
  在已落库的事件载荷上做子串匹配（LIKE 通配符**转义**），再按"可见文本（正文 / 推理增量）"
  **复核一次**，把只命中结构化字段（工具入参键名等）的**假阳性排除**并如实报出条数。
  口径与"排除了多少条"随响应返回，页面**原样转述**服务端的话。

**3.6 实施中的关键设计判断**

1. **注入段要能被机读切分**：注入之后 `turn-start` 事件的 text 就是"用户输入 + 附件正文"，
   而工作台要把它回放成**用户气泡**。整段回放是**说谎**（用户没说这些），
   把 60KB 文件糊进气泡又没法用。所以在注入处放一个**分界标记**
   （服务端 `ATTACH_INJECT_BEGIN` / 前端 `WB_ATTACH_MARKER`，两个字面量**必须一字不差**，
   由 `test-frontend` 的**契约对账**用例钉住）。气泡 = 用户真打的字 + 一句"＋N 个附件已注入"，
   「轨迹」里仍是完整原文 —— **显示层可以化简，数据层不许**。
2. **"剥掉"不等于"不显示"**：附件数**从落库原文里数出来**（数 `<attachment ` 出现次数），
   而不是另存一个字段。回放时不依赖任何额外状态，且"标记在 = 当时真注入过"是同一份事实的两个视图。
3. **停止必须能回答"上游停了吗"**：这是两个不同的结论，混成一个 `ok: true` 就等于
   在"平台已经停手"和"钱已经不再花"之间偷换概念。所以 `upstream` 是独立字段。
4. **重生成的按钮只挂在最后一条助手消息上**：中间那些回合已被后面的内容覆盖，
   给它们挂按钮会让人以为"可以退回那一步"，而上游没有这个协议。
5. **附件是"按 id 直接寻址"的资源**：仓储层每一句 SQL 都带 `tenant_id`**且带 `session_id`**
   —— 不允许"先查会话再判断归属"这种间接推理（写快一步漏掉就是"知道 id 就能下载别家文件"）。
   `hydrate()` **不输出 `stored_path`**（部署机目录结构不进响应，换机器就成死链）。
6. **删除要落到字节上**：只删元数据是**假删除**。合规上的"删除请求"必须真的把内容删掉，
   删不掉也要如实回报 `bytesDeleted:false` + 原因，而不是回一个 `ok:true`。
7. **勾选态用文本符号而不是原生 `checkbox`**：整页是"状态变了就整页重绘"，
   原生 checkbox 的浏览器内部勾选态会在重绘前先翻一次（用户看到双击般的闪烁），
   `data-act` 又再翻一次 → 叠加成"点一下没反应 / 点一下翻两下"。
   纯文本符号没有内部状态，显示什么完全由 State 决定，不存在两个真相。
8. **`wbRunTurn` 是 `wbSend` / `wbRegenerate` 的唯一实现**：两者只差"要不要再插一个用户气泡"。
   共用是为了让"停止、用量、附件回执"只有一份逻辑 —— 否则会长出
   "重生成时停止失灵"这类只在一条路径上出现的缺陷。
9. **mock 与真实 provider 的回合起点语义必须一致**：真实 provider 早已用 `turnBase` 记下
   "本轮的起点"并**刻意不认**调用方给的 `fromSeq`（两套编号）；mock 却把 `fromSeq` 直接当数组下标。
   **同一份契约两种语义本身就是缺陷** —— 详见下面的回归抓出的缺陷 1。

**回归抓出的真实缺陷（3.6）**

1. **一次"停止"会污染此后每一轮**（`app/kernel/mock-provider.mjs`）——本批最严重的一个。
   `runTurn` 传给 provider 的 `fromSeq` 是"**平台库已落库**的最大 seq"。上一轮被停止/超时截断时，
   平台只落了前一半，这个数就**小于**上游已产出的事件数。mock 拿它当数组下标 →
   本轮从上一轮的中间插进去，把上一轮的尾巴当成自己的事件吐出来，
   并在上一轮的 `turn-end` 处收流 —— **本轮真正的事件永远落不了库**，表现为"答非所问"。
   修：`submitTurn` 记下 `s.lastTurn = {turnId, startSeq}`，`streamTurns` 起点取
   `max(本轮的 startSeq-1, 调用方给的 fromSeq)`；没走过 `submitTurn`（补看历史）时退回 `fromSeq`。
2. **中文名附件一律下载失败 500**（`kernel.mjs`）：`content-disposition` 里直接放了中文文件名，
   而 **HTTP 头值只允许 ASCII** —— Node 抛 `Invalid character in header content`。
   修：两个都给，`filename=` 用纯 ASCII 兜底名（非 ASCII 替换成 `_`）+ `filename*=UTF-8''…` 带真名。
3. **"请求体过大"变成了 500 internal_error**（`app/util/errors.mjs`）：`readJsonBody` / `readRawBody`
   抛的是带 `{code, httpStatus}` 的**普通 Error**，而 `toHttpError` 只认 `AppError` →
   413 被吞成 500，调用方看到的是"服务器坏了"，而真实原因（该传小一点）一个字都看不到。
   这是 M0 起就潜伏的缺陷，直到附件上传把 413 这条路第一次真正走到才暴露。
   修：`toHttpError` 也认"自带 HTTP 语义的非 `AppError`"。
4. **工作台的 `notice` 写了却从不渲染**（`public/app.js`）：新建会话 / **模型登记** /
   附件上传部分失败 / 停止的上游结果，四处提示都只写进 `State.wb.notice`，
   而**没有任何地方渲染它**。后果最重的是"模型登记"那条 —— 用户在成本页看到用量进了
   「未归因」桶，而界面当时明明想说"已为本会话登记模型：…"，只是没人看得到。
   修：在 `pageWorkbench` 里渲染 `w.notice`，并加一条用例钉住。
5. **我自己给回放数据编了个不存在的断言**：把"注入段不许出现"写成对**整页 HTML** 的断言，
   而注入段的原文本来就该出现在「轨迹」里（轨迹 = 平台实际发出的原文，它必须等于事实）。
   修：断言收敛到**用户气泡内部**，并同时断言"轨迹里必须保留完整原文" ——
   两条一起才表达出"显示层化简、数据层不动"这个真正的结论。

**回归与审计（0.10.0 收口实测；括号内为 0.9.0 时点）**

| 脚本 | 结果 |
|---|---|
| `test-core` | 用例 **156**（151）｜ 失败 0 → `DONE fails=0` |
| `test-http` | 用例 **69**（67）｜ 失败 0 → `DONE fails=0` |
| `test-knowledge` | 用例 34 ｜ 失败 0 → `DONE fails=0` |
| `test-governance` | 用例 48 ｜ 失败 0 → `DONE fails=0` |
| `test-stream` | 用例 22 ｜ 失败 0 → `DONE fails=0` |
| `test-frontend` | 用例 **89**（87）｜ 录制 **102**（101）｜ 失败 0 → `DONE fails=0` |
| `audit-layering` | `DONE fails=0` |
| `audit-tenant-isolation` | 隔离表 **18** 张 ｜ 语句 **141** 条 ｜ 违规 0 → `DONE violations=0` |
| `main.mjs --check` | 路由 **107** 条（public 8 / session 54 / admin 45）｜迁移 **0012**｜无阻塞问题 |

合计 **418 用例**（156 + 69 + 89 + 34 + 48 + 22；0.9.0 时为 409）。

**待办（明确保留，不做）**

- [ ] **`style-src` 去内联样式属性**（3.4 的**另一半**）：把 123 处 `style="..."` 迁到 class。
  保留理由：内联样式能造成的危害（样式注入、布局破坏）与内联脚本不在一个量级，
  为它做 123 处改写性价比很低。已写在 `security-headers.mjs` 注释与 `deploy.md` 能力表里，**不假装去干净**。
  ✅ **0.10.0 补了一道护栏**：`test-frontend` 把当前计数（**123**）**冻成断言** ——
  新增一处内联样式就必须改基线，"改基线"会被看见。（3.4 时是 122，3.6 加 `＋附件` 的隐藏 input
  变成 123 而**没被发现**；这正是"只在文档里写数字"的破口。）
- [ ] **官方 `Dockerfile`（容器交付）** → ✅ **已决策：暂不提供**（2026-10-01，由项目负责人拍板）。
  维持「解压 → 双击 `start.cmd` / `start.sh`」。**客户提出容器需求再补** —— 届时三条硬约束已记录在先：
  ① `data/`（含 `.secret` 主密钥）**必须挂卷、不得烧进镜像**；② 上游 DSH **独立装在宿主机**，
  容器内如何接入需另行设计；③ 单容器仍是"单进程优先"，不引入多容器编排。见 `docs/feasibility.md` §8 决策点 5。
- [x] ~~**署名主体口径**~~ → ✅ **已决（2026-10-01）：统一为完整署名 `Copyright 2026 liwei（易智瑞西安）`**。
  署名是**唯一**保留权利人实体名的位置；`start.cmd` / `check.cmd` 因 PURE ASCII 约束保持拼音形态
  `(YiZhiRui Xi'an)`（见 `docs/feasibility.md` §8 决策点 6）。⚠️ 这与产品命名无关：命名（产品名 /
  库文件名 / 格式串 / 环境变量 / 指标名 / 响应头 / cookie / 令牌前缀 / 注入标记）已在 **0.10.1**
  全部改为自有命名。
- [x] ~~**把附件真的送给模型**~~ → **0.10.0 已接通「图片」通路**（PNG / JPEG / WebP / GIF 按**魔数**识别，
  作为 `{type:'image'}` 内容块真的送给模型）。
  ⚠️ **更正**：0.9.0 那条"平台没有上传附件的通道"是**假话** —— 写入通道一直在
  `submitTurn` 的 `content` 内容块数组里，`toBlocks()` **原样透传**；当时只看了"读"的
  `readAttachment` 就断言"没有写通道"，是只看了契约的一半（详见 `architecture.md §7.7`）。
- [x] **「通用文件」（PDF / ZIP / DOCX…）送给模型** → ✅ **已实测结案（2026-10-02）：当前上游 wire 契约不提供该通路；维持现状**（只登记 + 可下载 + 逐条点名 `skipped[]`，页面如实标"不提交"）。
  **实测对象**：运行中的 DSH `0.2.0-rc.2`（rev `72da61f1da14`）。
  **① 写入通道：存在，但没有出口。** `fileUploads/upload` **可用**（形状 `{agentId, request:{data(base64), name}}`），
  返回 `{receiptId, file: FileAttachmentRef}`；而 `FileAttachmentRef = {attachmentId, name, bytes}`，
  类型定义明写 `attachmentId` 是 "Opaque content-addressed storage identifier;
  **never a filesystem path** or bearer URL" —— **返回里没有任何路径**（实测拿到 `sha256:cd0aa985…`，内容寻址、同内容同 id）。
  **② 提交通道：wire 不接受 `file` 块。** 类型里确有第三种块
  `AttachmentAdmissionPart = PromptContentPart | { type:'file', attachment: FileAttachmentRef }`，
  但那只在 **host / admission 层**；wire 层 `PromptContentPart` **只有 `text` 与 `image`**。
  实测印证：`content` 里放 `{type:'file', attachment:ref}` 与 `{type:'file', data,name}` **两种形态都被拒** ——
  `gateway/input-invalid … wire field "request" failed boundary validation`（报错**不点名**具体字段）。
  **③ 同级字段路线：被证伪（本轮最容易自我欺骗的一处）。** 往 `request` 上加
  `attachments` / `files` / `fileUploads` / `attachmentRefs` 都返回 `{"accepted":true}` —— 看似成功；
  但**对照组**（乱造字段 `zzzNotAField`）**同样 accepted** ⇒ **校验器静默忽略未知字段**，
  `accepted` **不是**"已生效"的证据。再查**上游实际组装的投影**
  （`<DSH_HOME>/storages/session_projcache/sessions/<id>.json`）—— 5 条排队回合的 `content`
  **只有 `[{type:'text',…}]`**，文件字段被**整体丢弃**，文件名 / `attachment` / `"type":"file"` / 路径 关键字 **0 命中**。
  **④ 只读侧：20 个候选方法全部 404**（`fileUploads/list|read|stat|resolvePath`、`attachments/list|read`、
  `attachment/filePath|hostPath`、`attachments/fileHostPath`，以及按官方 README 函数名试的
  `fileHostPath` / `saveFile` / `readFileStream` 等）。
  **结论**：官方 README 描述的"模型收到一行**只读路径**文本"是**上游 host 侧内部投影**
  （`ctx.attachments.admitPromptContent()`）的能力，服务对象是 DSH **自己的浏览器通路**
  （类型注释原文：Browser-submitted prompt content accepted by **Host prompt endpoints**）——
  **不对外部 wire 调用方开放**。所以平台侧**无从接线**；且这**不是"上游没有这个能力"**，
  而是"该能力不在 wire 契约上"（两者的区别要如实说）。
  ⚠️ **历史更正**：本条此前写作"（`fileUploads/upload` + 保存路径，B 档）…**探针已就绪、等上游实测**" ——
  "等上游"这个说法**不准确**（探针早就该跑，且**一跑就出结论**）。另外 `fileUploads/upload` 这个名字的旧出处
  `compat/0.1.5-rc.2.mjs`（标 `verified: true`）**整体已被证伪**（那张表 9 个方法名在上游不存在）；
  本次它**碰巧真的存在**，但那是**实测**的功劳，**不是**那份静态表的功劳 —— 这条区别不能含混。
  📌 **重新评估的条件**（任一出现即可复用现成探针）：上游把 `file` 块开进 wire `PromptContentPart`，
  或暴露出任何可取"只读路径"的 RPC。探针仍在 `tools/verify-upstream.mjs` **阶段 3**（`--read-only` 可空跑）。
  ⚠️ 本次探测在上游留下可辨认残留：1 个 **1 字节**内容寻址对象（`sti-verify-1byte.txt` / `sti-tmp-1byte.txt`，
  同一 `sha256:cd0aa985…`）与 4 个探测会话；**探针刻意不做自动清理**（"上游有没有删除接口"本身是待测项）。
- [x] **3.1–3.3 / 3.5 的收口复核**（0.8.0 已交付，检查是否有遗漏的边界）。
  ✅ **已复核（2026-10-01，逐项实测实装 + 回归证据）· 无遗漏边界**：
  ① **3.1 审批超时** —— `approvals.expireStale()`（`governance/approvals.mjs`）+ 调度任务 `approval.expire`
     + `test-core` 用例（`expireStale 把超期 pending 转 expired；decide 拒绝已过期的单`）；
  ② **3.2 `concurrent` 真闸** —— `governance/concurrency.mjs` 的 `enterConcurrent`（判定+入场原子）
     挂在 `http/routes/kernel.mjs` 的 `withTurnGate` 上（**两条**回合路由）；配对纪律写在函数注释里；
  ③ **3.3 审计保留/归档/锚定** —— `audit.archive()` / `anchor()` / `chainInfo()` / `listAnchors()`
     （`DEFAULT_RETENTION_DAYS = 90`），删除动作本身入链；
  ④ **3.5 知识重试 + 重新向量化** —— `reprocessDocument` / `retryDocument` / `reindexBase` /
     `embeddingConsistency`（迁移 `0010` 记录 embedding 的 provider/model/dim，`reindexBase` 才有意义）。
  ⚠️ 复核同时确认：**唯一有意不做的仍是 `style-src` 去内联样式**（见下一条）。

---

## 跨切关注点（贯穿所有里程碑）

| 关注点 | 要求 |
|---|---|
| **诚实数据源** | 任何探测失败 / 能力降级，必须在上报数据里带 `source` 与 `degraded` 标记 |
| **分层审计** | `tools/audit-layering.mjs` 进 CI，任一里程碑都不得让 DSH 名词泄漏到 L3/L5 |
| **回归脚本** | 每个里程碑结束必须让全部脚本末行输出 `DONE fails=0`；脚本本身零依赖 |
| **迁移纪律** | 数据模型变更只走增量迁移文件，不改历史迁移 |
| **契约稳定性** | `KernelEvent` 形状变更要走契约版本号；provider 适配层独立演进 |
| **文档同步** | 改架构先改 `docs/architecture.md`，再改代码 |

---

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `node:sqlite` 仍为 experimental，未来 API 可能变 | 数据层返工 | 驱动收口为 4 个原语；SQL 限定稳定子集；预留降级为 JSON 仓储；唯一允许破例引入第三方驱动的位置 |
| 纯 Node 文档解析能力有限（PDF/DOCX/OCR） | 知识库覆盖度不足 | 纯 Node 格式开箱即用；复杂格式走**可选外部命令**，探测不到明确降级，不假装成功 |
| 暴力向量检索在百万级失效 | 检索变慢 | `VectorIndex` 抽象预留（`retrievers/index.mjs` 的 `createVectorIndex()`）；文档中写明 10 万 chunk 量级边界；超限给出明确指引而非静默变慢；**向量预过滤已实装（默认关，会改变答案，代价已实测）** |
| 单进程成为并发瓶颈 | 服务退化 | CPU 密集任务全部进 `worker_threads`；进程内状态全部收口到 db + 缓存接口，为多实例留路（不实现） |
| DSH 上游破坏性变更 | 平台不可用 | 契约层 + `dsh-provider/compat/` 按版本隔离；升级前跑契约层回归；mock-provider 保证无 DSH 时仍可自检 |
| **上游版本已跑在验证矩阵之前**（实测：本机 `0.2.0-rc.2`，矩阵内只有 `0.1.5-rc.2`/`0.1.6-alpha.1`） | 门禁常态化黄灯，久而久之被忽略 | 门禁**只黄不红**是刻意的（不阻断启动）；但升级流程必须走到「跑 fixtures 回归 → 更新矩阵」。⚠️ **fixtures 未建时，M0 结论是不把 0.2.0-rc.2 列入已验证**——没跑过就不许标已验证 |
| **`tools/test-core.mjs` 曾把「没跑」显示成「绿了」** | 假绿灯比红灯危险得多 | 测试骨架支持 `{skip:'原因'}`，跳过**单独计数、单独打印**，绝不计入通过；末行仍是严格 `DONE fails=0` |
| ~~**fixtures 回归缺失**（M0 未交付）~~ | ~~「事件字段静默变空」无法自动发现~~ | ✅ **已补齐**（M1 开头），并立刻抓出 3 处静默失效。见「M0 缺口已补齐」 |
| **「接口层」的错不会被「单元层」的回归抓到** | 凭据 `hasValue` 那类缺陷只在响应体里错一个字段 | 新增 `tools/test-http.mjs`：真起 `http.Server` + 临时库 + 随机端口，端到端断言 41 项 |
| **Cookie 认证下的 CSRF** | 浏览器会自动替用户带上凭证 | `SameSite=Lax` 已挡现代浏览器的跨站 POST；另加 `Sec-Fetch-Site` / `Origin` 显式判定并**留审计**，且 Bearer 认证不受其约束（`csrfVerdict` 有 1 组纯函数用例钉住） |
| 范围蔓延（「顺手也做个 XX」） | 首期无法交付 | `docs/architecture.md` §10「明确不做的事」作为拒绝依据；四项能力之外的功能一律进 backlog |
| **单进程 + SQLite 单写在并发下不足** | 事件落库排队、服务退化 | **写合并**（内存队列 + 批量提交事务）；写明实测吞吐上限；为换驱动留路 |
| **中文检索按 unicode61 实现会召回归零** | 知识库「能建库、搜不到」且隐蔽失败 | 改 **bigram 预处理**（feasibility §1.2.1）；M2 加中文召回回归用例 |
| ~~**与 dsh-console 双线维护**，DSH 升级改两处~~ | ~~维护成本翻倍~~ | ✅ **已消除**（2026-10-01 决策 **A 吸收**）：旧项目冻结为轻量版、停止新增功能；适配层收口到本仓 `app/kernel/dsh-provider/`，两边共用同一套升级动作。落地说明见 `docs/compatibility.md` §7 |
| **配额无法事前拦截**（无 model gateway） | 超配额只能记账不能刹车 | ✅ **前提已验证**：DSH 支持自定义 base URL（`feasibility.md` §1.2.3.1）→ 先做 A（事后统计 + 事后阻断会话），**挂 gateway 升级为事前拦截尚未排期**。⚠️ 施工红线：gateway 须实现 **Anthropic Messages 协议**（`/v1/messages` + `/v1/files`），**不是** OpenAI 协议；baseURL 不得带 credentials/query/fragment |
| **前端复用 12461 行 `app.js`** | 隐性延期（最大来源） | 改为**重写前端骨架 + 摘取成熟组件**，不做整体迁移 |
| **安全模型从本机变多用户** | 暴露含凭据代理 → 事故 | feasibility §7.2 专项：HTTPS + CSRF + Cookie Secure + 限流 + 会话超时 |
| 文档解析依赖的外部命令在客户机未装 | 知识库覆盖不足 | M2 先做**现场探测矩阵**；缺失即降级并标注 |

> 完整 16 条风险矩阵（含概率/影响/等级）见 `docs/feasibility.md` §5。

---

### P3 · 长期可维护性（A6 前端分片 + A5 文档单一真相源）· 0.11.2

> 来源：`assessment-0.11.0.md` §A5 / §A6，在 §C 的建议顺序表里列为 **P3（中 · 长期可维护性）**。
> **这一版没有新增任何能力** —— 两项都是"结构"。判断依据是：0.11.0 体检里代码侧的问题都已清完，
> 剩下的最大风险不再是"缺功能"，而是"改一处要翻 4,779 行"与"同一条边界散在 7 份文档、改一处漏六处"。

#### A6 · 前端按域拆分

**原状**：`public/app.js` 4,779 行 / 264 KB，零模块化。

**关键约束（不能说放就放的）**：零构建是**刻意的** —— 本项目要的是**可审计**
（`node --check` + `vm` 真跑回归），不是开发体验。体检 §A6 自己也写明"不建议为了好看引入打包器"。
所以拆分方案被限定在：**经典脚本 + `index.html` 顺序加载 + 共享全局作用域**，不引入 ES module 工具链。

落地清单与四条纪律见 `architecture.md` §7.8。三个容易踩的坑（都已写进回归）：

1. **顺序即依赖**：分片顺序不能按文件名字母序随手排；回归直接断言"顺序 == 文件名的数字前缀升序"。
   没有这条，某天挪一行就变成"某个 `const` 还没声明就被引用"—— 而这类错**只在浏览器里炸**。
2. **不能把分片拼成一个大脚本去跑回归**：第二片起的 `'use strict'` 会退化成普通字符串表达式，
   后半段**静默脱离严格模式**。那等于"回归跑的语义和浏览器不一样"，比不跑更糟。
3. **`App` 对象不能跨片**：它是对象字面量。本轮**没有拆它**（继续拆要改成 `Object.assign(App, {…})`）——
   如实写进 §7.8，而不是在文档里写一句"已模块化"了事。

**"零语义变更"的证法（比拆分本身更重要）**：用独立脚本按**非空行集合**比对"16 片拼回去 vs 原文"，
4,489 行 / 208,092 字符**无差异**；16 片逐片 `node --check` 通过；`test-frontend` **97/0** 全绿。

#### A5 · 文档单一真相源 + 历史快照归档

**原状**：「单进程」39 处、「暴力扫描」13 处、「只读保存路径」9 处，跨 6~7 份文档 —— 改一次要改 7 个地方。

**为什么直接照建议做会有害**：§A5 的建议是"其余文档改为引用而不是复述"。但那 39 处的相当一部分
写在 `roadmap.md` / `feasibility.md` / `assessment-*.md` 里，是**当时怎么判断的证据**。
删掉它们能凑出"全文只出现 N 次"的漂亮数字，代价是**销毁决策记录** ——
而保留证据恰恰是 B1 那类"文档虚构对策"唯一的解药。**因此改用三分法**（写进 `docs/README.md`）：

| 类别 | 是哪些 | 规矩 |
|---|---|---|
| **属主**（normative） | `architecture.md` §9/§10、`deploy.md` §10、`benchmark*.md` | 陈述**当前事实**；要改边界只改这里 |
| **摘要**（summary） | `README.md` 等首屏材料 | 给结论 + 指向属主；**与属主冲突时以属主为准** |
| **记录**（record） | `roadmap.md` / `feasibility.md` / `assessment-*.md` / `history/**` | 写的是**当时**的判断，保留原话是故意的；**不得当现状读** |

另：`assessment-0.6.0.md` / `assessment-0.7.0.md` 移入 `docs/history/` 并加 `⚠️ 历史快照` 横幅，
仓库内 **27 处引用（8 个文件，含 `app/` 与 `tools/` 里的注释）** 同步改路径。

**这条规矩怎么防止再漂**：下次要改"单进程"的表述，`docs/README.md` 的表直接指出改哪一份；
读者在别处看到复述时，也知道该以属主为准。

---

## 版本规划

| 版本 | 内容 |
|---|---|
| `0.1.0` | M0 骨架 + 契约层 + 自检 + 启动器（**可运行、可自检，但只有 mock-provider 与只读页面**）。⚠️ **fixtures 顺延至 M1 开头**；上游 base URL 前提已验证（§1.2.3.1） |
| `0.2.0` | ✅ **M1 身份与权限**（可登录、可授权、可管凭据）。⚠️ 配额与审计查询仍是占位；对外部署**必须**配 TLS 反代 |
| `0.3.0` | ✅ **M2 企业知识与检索**（解析 / 分块 / bigram 中文检索 / 向量混合 RRF / 引用溯源 / 库级隔离 / 知识库前端）。**一次交付完整版**（不再拆精简版与完整版两刀，见下方说明）。⚠️ 向量为暴力扫描（10 万 P95 1.2 s）；rerank 延后 |
| `0.4.0` | ✅ **M3 治理与审计**（哈希链审计与查询/校验接口 + 配额 block/warn 拦截 + 审批队列 + 真实 usage 采集 + 治理前端三页 + 工具网关）。⚠️ 产物留存（ZIP 导出）顺延至 M4 开头；配额的 token 类指标是软闸（已用量 ≥ 上限时阻断下一次提交），精确事前拦截待 model gateway（尚未排期） |
| `0.5.0` | ✅ M4 能力分发（Skill / 工具 / MCP 清单与三级可见性治理） |
| `0.6.0` | ✅ M5 企业化收口（多租户审计、备份恢复、完整回归、打包）→ **「完整企业版」**。⚠️ **model gateway 未做、SSO 如实不实装**（见 `history/assessment-0.6.0.md`）；0.6.0 的回归全在 mock 内核下跑 |
| `0.7.0` | ✅ **P0 运行时打通**（接通真实 DSH + 6 个小缺陷 + 回合流式化 + 用户对话工作台 + groups 表 + operation 门面）**+ P1-1 模型中心**（多 provider 配置 / 探活 / 默认与降级链 / 知识层接缝）**+ Apache-2.0 许可证**（`LICENSE` + `NOTICE`）+ 「A 吸收」dsh-console 关系定案 |
| `0.8.0` | ✅ **P1-2 治理闭环与运维底座**（`history/assessment-0.7.0.md` §6.2 第 1+2 步）：定时任务底座 + 出站通知/告警 + `/metrics` 指标端点 + 审批超时 + 审计保留/归档/链尾锚定 + `concurrent` 并发真闸 + 知识重试与重新向量化；新增**调度中心**与**通知渠道**两个页面。⚠️ 边界：调度器**不是 cron**、进程停了就不跑且**不补跑**；通知**尽力而为**，停机期间告警会丢；锚点只有出站才具备独立证明力 |
| `0.9.0` | ✅ **P1-3 集成与体验（已收口）**：**OpenAPI 规格导出**（从路由表生成，不手写）+ **成本核算**（token → 金额：单价登记 / 归因链路打通 / 未定价显示为"未定价"而非 0）+ **CSP 去 `unsafe-inline`**（内联事件属性全改事件委托 + 首屏脚本外链，`script-src` 收到 `'self'`）+ **工作台最后一公里**（停止真通知上游 / 重生成 / 附件 / 服务端会话内检索）。⚠️ 边界：金额是**估算不是账单**（按当前单价、不追溯）；只有会话**登记过模型**的用量才归因得起来，其余进 `unattributed` 桶；**通用二进制附件**（PDF/ZIP…）不会被送给模型（走上游**只读保存路径**的 B 档尚未接通，页面如实标注）；`style-src` 的 `unsafe-inline` 仍在（123 处内联样式属性，理由已写明） |
| `0.10.0` | ✅ **附件图片通路 + 文档纠错**：**图片真的送给模型**（PNG / JPEG / WebP / GIF 按**内容魔数**识别 → `{type:'image'}` 内容块随 `submitTurn` 提交；本轮合计 ≤ 10MB；垫片不支持时保守不发并如实点名）+ 上传落库 `mime` 改取**内容嗅探**结果 + 第二条跨端契约（`describeImages()` ↔ `WB_IMAGES_RE`）+ **`style-src` 护栏**（把内联样式计数冻成断言，防无声增长）。**并更正 0.9.0 的一处硬错误**：那句"平台没有上传附件的通道"是假话（写入通道一直在 `submitTurn` 的 `content` 数组里）。⚠️ 边界：`fileUploads/upload`（通用文件的**只读保存路径**通路）**仍未接通**，探针已列入 `tools/verify-upstream.mjs`。**本轮决策（2026-10-01 拍板）**：官方 `Dockerfile` **暂不提供**（客户提再补） |
| `0.10.1` | ✅ **全量更名（STI HARNESS）**：产品名、库文件名、备份/能力格式串、环境变量前缀、Prometheus 指标名前缀、响应头前缀、会话 cookie 名、令牌前缀、附件注入标记、`localStorage` 键 —— **一次改到底**。**兼容取舍写清楚**：格式串改**形态**校验（历史备份包/能力清单照用，恢复落规范名）、注入标记**写规范认形态**（历史会话仍可读）、非规范库文件**只报告不采纳**（`tools/adopt-data-dir.mjs` 用 `VACUUM INTO` 做事务一致快照，只复制不删原件）；**破坏性**：指标名/响应头/令牌前缀/cookie 名变了 → 面板查询要改、需重新登录一次、API Key 需重新签发。⚠️ 刻意**不做**"扫描全库禁止出现旧名"的断言：那条断言必须把旧名写进源码，等于又引入一次 —— 改对**新命名的常量做正向断言**（回退即红） |
| `0.10.2` | ✅ **备份保留策略（轮转）**：`backup.create` 新增 `keep` 参数（**默认 30 份**），每轮**先建成功、再轮转**（顺序反了就是净损失，有回归钉住）；轮转只认 `backup-*.zip`、**至少保留 1 份**（`keep: 0`/负数抬到 1，**不是**回退默认 —— 否则"配了 0 却留 30 份"）、删除动作单独入审计（`operation.backup.prune`）、**无 HTTP 删除入口**（反向断言钉住）；轮转失败不上抛、不污染 `fail_count`，错误如实回报在 `rotateError`。顺带把 `backup.mjs` 两处硬编码库名改为 `DB_BASENAME` 单点。⚠️ **备份任务不默认播种** —— 需运维在**调度中心**建一条（建议 `dailyAt:03:00` + `{"keep":30}`） |
| `0.11.0` | ✅ **知识库级 ACL（4.6）**：租户内按库授权 —— `knowledge_bases.visibility`（`tenant` 全组织可见 / `restricted` 仅授权可见，**默认 `tenant`**，迁移 0013 只 ADD COLUMN）；授权载体**复用 `role_bindings` 的既有预留**（`scope_type='knowledge_base'` + `scope_id`，**零新表**）；判定是纯函数（`knowledge/visibility.mjs`）—— 有效角色 = **全局角色 ∪ 库级角色**，并集**只作用于本库**。三条安全线：**不可见一律 404**（不确认受限库的存在性）、**管理员对受限库恒可见**（防自锁：设成受限后不至于没人能改回来）、**授权名单本身要 write 档才能看**（名单暴露组织分工）。配套接口：`PATCH /api/knowledge/bases/:id`（改可见性）、`GET/POST/DELETE /api/knowledge/bases/:id/grants`（库级授权）；改可见性与授权/撤权**强制入审计**。⚠️ **库内写动作的权限判定下移到服务层**（路由门用 `knowledge:read`）—— rbac 只看**租户级**角色，若路由写 `knowledge:write`，库级管理员会被挡死、4.6 等于没做；写路径由服务层按库判定，**反向断言钉住**。⚠️ 界面提供"可见性"开关与徽标；**库级授权的界面入口未做**（接口就绪）→ 排入 **0.11.1 之后**（**已在 `0.12.0` 补上**，见下一行） |
| `0.11.1` | ✅ **体检项收口（P0/P1/P2）**：① **B8 部门收口** —— `departments` 从"能引用、不能创建"补齐为可用（`GET/POST /api/identity/departments` + `PUT /api/identity/users/:id`），账号页加部门面板与「改归属」，**顺手堵掉一个跨租户漏洞**（`deptId` 原先原样写库）；并明确**部门不是权限载体**（挂进"管理员部"不会得到任何权限）。② **B5 通知失败重投队列** —— 迁移 `0016_notify_deliveries.sql` + 定时任务 `notify.retry`（指数退避、最多 6 次、超限转 `dead` 但**保留可见可手动重投**）+ `GET /api/notify/deliveries` 与 `POST …/:id/redeliver` + 通知页队列面板；语义为 **at-least-once**（同一条投递的所有尝试共用 `X-STI-Delivery-Id`）。③ B2 检索预过滤、B11 并发压测、A1/A2/A3/B1/B3/B4/B7 等 P0/P1 项。⚠️ 修订 0.8.0 的"通知**不做持久化重试队列**"（`roadmap` 关键判断 #8 已同步改）；**修订后仍成立的边界**：平台**整体停机**期间告警照样会丢（单进程、无分布式锁）。⚠️ 库级授权的界面入口仍在 0.11.1 之后 |
| `0.11.2` | ✅ **长期可维护性（P3 · 体检 §A5 + §A6）**：① **A6 前端按域拆成 16 片** —— `public/app.js`（4,779 行 / 264 KB）→ `public/app/*.js`，由 `index.html` **顺序**加载；**仍是经典脚本 + 零构建**（各片共享全局作用域、彼此直接引用，无 import、无打包器），`node --check` 与 `vm` 真跑回归照旧。**零语义变更**（按非空行集合比对，4,489 行 / 208,092 字符无差异；逐片语法检查通过；`test-frontend` 97/0）。⚠️ 回归改为**逐片执行**（把十几片拼成一个大脚本会让第二片起的 `'use strict'` 退化成普通字符串表达式，后半段**静默脱离严格模式**）；⚠️ **`App` 对象仍集中在 `70-app.js`（约 1,620 行）**，未拆完这件事写在 `architecture.md` §7.8。② **A5 文档单一真相源 + 历史快照归档** —— 新增 `docs/README.md`（每条边界陈述**指定唯一属主**；文档分「属主 / 摘要 / 记录」三类，冲突时以属主为准）；`assessment-0.6.0.md` / `0.7.0.md` 移入 `docs/history/` 并加 `⚠️ 历史快照` 横幅，仓库内 27 处引用改路径。⚠️ **与 §A5 建议不同之处（故意）**：记录类文档（roadmap / feasibility / assessment / history）里的重复**保留不删** —— 删掉 39 处「单进程」等于销毁决策证据，那不是去重，是丢档 |
| `0.12.0` | ✅ **库级授权的图形化入口（体检 §D2 里到期的那一项 · B9）**：① **知识库页新增「库级授权」面板** —— 列名单 / 授权 / 撤权，主体（成员 / 用户组）与角色**只从下拉选**（手填 id 容易错，且会静默落库一条永不生效的授权）。⚠️ **这个面板的权限口径是全站唯一一处不一样的**：「能不能列/改名单」取决于你在**这个库**上有没有 write 档（路由门只要 `knowledge:read`，判定在服务层），因此**不按租户级 `knowledge:write` 关闭** —— 否则"全局 viewer、本库被授成 admin"的库级管理员（这个面板唯一真正的服务对象）会被挡在门外。正确姿势是照样渲染、把服务端结论原样呈现（`403` ≠ `404`，不含混）。② **修掉一个真实可达的缺陷**：授权主体原先**没有在服务层校验**，仓储层虽会校验但抛**裸 `Error`** → 出网变 `500 internal_error`，于是"这个账号已经被删了"在界面上显示成"服务器坏了"。授权入口有界面之后，下拉里的 id 在"加载后被删"的竞态下会陈旧 ⇒ 真实可达。按分层纪律（仓储抛裸 Error、**服务层**翻译成带 HTTP 语义的错误）修在服务层：不存在 → `404`、**其它组织的主体也按 `404`**（不确认它存在，与 `revokeScopedRole` 同一条纪律，否则这里会变成跨租户 id 探测器）、空主体/未知角色 → `400`。③ **修掉一处脚手架漂移**：`test-http` / `test-frontend` 里的知识服务**没有与 `app/main.mjs` 同构装配**（少了 `identity` / `resolveScopedRoles`）⇒ **库级 ACL 在这两套端到端回归里从未真正生效**（录制期表现为"授权接口报未装配"，判定则静默退化成"只看全局角色"）；这两套文件里 notify/schedule 的注释早就写明了同构装配的理由，知识服务只是漏了。回归：`test-core` **214/0**（+1）· `test-http` **78/0**（+1，把「不可见 404」与「档位不够 403」**分开**钉住）· `test-frontend` **104/0（录制 113）**（+7） |
| `0.12.1` | ✅ **备份的生产化落差（体检 §D2 剩余 · B10）**：体检给的结论是「**开箱即用 ≠ 开箱有备份**」，而**刻意不**默认播种 `backup.create` 本身是既有的产品决定（备份是消耗型动作）。所以本轮**不推翻那个决定**，改做它能被看见的那一半：① **自检新增第 `[14]` 项「备份与恢复」** —— 把三种"平时完全看不出来"的状态直接问出来：自动备份任务**没配**（附可直接照做的配置 `dailyAt:03:00` + `{"keep":30}`）／备份目录里**一份都没有**／**没有任何启用渠道订阅 `backup.failed`**；并把"恢复是离线动作""主密钥不在包内"两条边界再念一遍（此前只活在文档里）。② **查出并修掉一件更严重的事**：`backup.failed` 自 0.8.0 起就在通知白名单与文档里，**全项目却没有一个 emit 点** —— "备份失败会告警"一直是句**空话**（运维照文档订阅了也永远不会响）。现在自动备份失败即发 `backup.failed`（带原始错误），且**任务仍如实记 `fail`**；出站自身失败**绝不掩盖**原始错误；页面上「立即备份」失败**不**报同一事件（人在旁边看着的动作，错误直接给操作者，灌进告警通道只会被试错刷屏）。③ **订正一类会让人误判的表述**：白名单只说明"**允许**投递"，不等于"**真的会**"—— 截至本版真正有产生方的只有 3 类（`audit.anchor` / `model.probe.failed` / `backup.failed`），**`quota.blocked` 与 `approval.pending` 没有任何 emit 点**（接之前要先定节流策略，属产品裁决，记入 §D2）。为防复发，新增 `NOTIFY_EVENT_PRODUCERS` **对账表** + 回归**双向静态核验**（正向：表说有产生方 → 文件里必须真有 emit 点；反向：全 `app/` 字面 emit 的事件集必须**恰好等于**表里那批）。⚠️ 反向核验必须**先剥注释**再扫，否则会随"某人改了一句注释"假红 —— 会假红的守卫最后一定被关掉。④ **顺手修掉两处早已失真的文档**：`deploy.md` 的「自检 12 项」实际早已 13 项（第 `[13]` 凭据表安全自 0.8.0 就在跑）→ 改为 14 项并补齐两行；同处「默认播种**三**个任务」实际早已 5 个（会话清理与通知重投在 0.11.1 加入）→ 改为五个并点明"自动备份刻意不在其中"。回归：`test-core` **217/0**（+3）· `test-http` **78/0** · `test-frontend` **104/0（录制 113）**（共 **504 用例**） |
| `0.13.0` | ✅ **§D2 剩余项收口（推荐做的全做完，不推荐做的只给理由）**：① **两个"有名字没产生方"的事件接通** —— 新建 `app/platform/notify/producers.mjs`（`emitQuotaBlocked` / `emitApprovalPending`），接在**真正的拦截点**（quota 中间件 block / 内核并发闸 block / 工具审批门 403）；**会成串发生的事件接产生方必须同时接节流** —— 同一 `(租户, 事件, dedupeKey)` 10 分钟窗口内最多出站一次（`dedupeKey` = 哪个指标 / 哪个工具），**节流合掉的是通知不是事实**（每次拦截 / 每张待办仍逐条进审计 / 队列），且**先确认"有渠道会收到"再计时**；`void emit…()` 不 await（不许阻塞、不许影响判定）。② **A2(b) 逐项对账** —— 代码早在 0.11.1 就清完，"仍未做里写 A2(b) 未动"是**假话**（处置记录的"未动"与"假装做了"等价，方向相反）；`assessment-0.11.0.md` §A2 如实列出 删除 12 / 补出口 2 / 刻意保留 1 / 原表自己错 1（`countActiveAdmins` 从未存在）。③ **`App` 对象拆片收口** —— 新建 `public/app/71-app-workbench.js`（553 行、25 个 `wb*` 方法、`Object.assign(App,{…})` 归并，**拆分不换命名空间**：`40-delegate.js` 按 `App.<action>` 取函数），`70-app.js` 1,690→**1,211 行**，前端共 **17 片**；守卫**先被改红**是它确实在工作过的正面证据。④ **出口补齐（能力面）** —— `capability.mcp.enabled`（**只认布尔**）/ `capability.mcp.remove` / `knowledge.bases.update`（改名 + 可见性），路由 **118→120**。⑤ **基准补能力** —— `--open-sender=process`（同进程开环**测不出拐点**：目标 30 req/s 只发得出 17.6 且该档错误 0 → 会得出"扛住了"的**与事实相反**结论）；新建 `tools/bench-scenarios.mjs`。⑥ **B11 实跑** —— 开环定速（**独立发包端**）+ 长稳 30 分钟。回归：`test-core` **222/0**（+5）· `test-http` **79/0**（+1）· `test-knowledge` **34/0** · `test-governance` **49/0** · `test-stream` **22/0** · `test-frontend` **104/0（录制 113）**（共 **510 用例**） |
| `0.13.1` | ✅ **开发 / 测试 / 维护的工程化收口（没有新功能，性质同 0.11.2）**：① **统一门禁 `tools/gate.mjs`（新）** —— 一条命令按固定顺序跑完全部检查（**项数现读 `--list`，不手抄**：0.13.1 建立时是 12 项，同版又加了版本号一致性守卫），末行 `GATE DONE checks=<通过>/<总项> skipped=… fails=…`。此前这 10 项**只能人工按顺序敲** ——"上一次发版到现在少跑了一个脚本"没有任何信号，而漏掉的那个恰好可能是唯一会发现当前改动的那个（0.12.1 的 `backup.failed` 空话、0.13.0 的压测对账假红都是这类）。⚠️ **判据是三条同时成立**：退出码 0 **且** 找到脚本约定的末行（`DONE fails=N` / `DONE violations=N`）**且** 末行数字是 0 —— **只看退出码**会把"脚本没跑到末尾（= 什么也没检查）"读成"通过"；矛盾时按不通过处理。⚠️ **SKIP 不计入通过**（无上游时外部两项如实记 `~`）。⚠️ 门禁**自己打印"它测不出什么"**（多机 / 多进程、开环定速与长稳、真上游对话、浏览器真实渲染、TLS 边界）—— 不说的门禁等于把"没测"伪装成"没问题"。② **新增 `tools/audit-orphans.mjs`** —— 模块**孤儿**（`app/` 下无任何入口可达；死导出还能扫到"没被引用"，死模块连扫描都扫不到，因为它自己就是那个没被引用的东西）· **断链 `import`**（指向不存在的文件）· **前端分片 ↔ `index.html` 双向对账**（磁盘上有、页面里没写 = 那片代码**永不执行**，而 `test-frontend` 的分片清单是**现读 `index.html`** 的、**发现不了这件事**）+ 加载顺序与文件名数字前缀一致。⚠️ 动态加载白名单（`compat/` 垫片由运行时拼接加载）**必须带"根据"**（`loadedBy` + `evidence`，审计核对根据是否还在）—— **一份不会过期的白名单就是一份假白名单**。③ **自证过的守卫才算守卫** —— 三类检查都先**故意改红**（临时孤儿模块 / 断链 import / 未登记的分片）确认会红且定位正确，再撤掉；写进 `architecture.md` §10 第 17 条。④ **补齐文档漏项**：README §5 的 tools 树漏了 `test-external-stream.mjs` 与 `adopt-data-dir.mjs`；`deploy.md` §10 两处标题仍写「本版（0.12.1）」而内容已是 0.13.0；README 缺 0.13.0 的版本记录块（从 0.7.0 起每版都有）。⑤ **版本策略重定基线**（本版最重的一件事）—— 原先把 `1.0.0` 当作「M5 完成」的标记，之后每轮收口都动 minor，于是 **minor 沦为"第几轮收口"的计数器**：产品尚未 GA 却自称 `1.8.0`，而同族前身 `dsh-console` 是 `0.1.5-rc.3`、依赖的上游是 `0.2.0-rc.2` —— 三个数字摆在一起必然被误判成熟度。现**整条历史重排回 `0.x` 线**（`1.0.0`→`0.6.0` … `1.8.0`→`0.13.1`；`0.1.0`–`0.5.0` 本来就诚实，不动），规则写死在 [`versioning.md`](versioning.md)：**`1.0.0` 保留给正式版**，minor 只在**能力面/契约变化**时 +1、收口走 patch、同一版内的多轮验收走 `-rc.N`。另区分开**三个同形但无关的版本序列**（产品 / 上游 DSH / 内核契约 `CONTRACT_VERSION`）—— 它们是本轮最大的操作风险：产品曾用过的 `1.0.0`/`1.1.0` 恰好就是契约版本的值，按字面替换会改坏代码与测试夹具。⚠️ 一处**刻意不改**：历史迁移 `0015_*.sql` 注释里的旧文件名（迁移有 `sha256` 校验和，改一个字符就让已部署的库报错）。回归：**用例数不变**（本版未动被测代码）—— `test-core` **222/0** · `test-http` **79/0** · `test-knowledge` **34/0** · `test-governance` **49/0** · `test-stream` **22/0** · `test-frontend` **104/0（录制 113）**（共 **510 用例**）；静态审计 **3** 个 0 违规；`gate` 末行 `GATE DONE checks=12/13 skipped=1 fails=0`（汇总「用例合计 524」= 主回归 510 + 外部内核 14，**两个口径别混读**） |
| `0.14.0` | ✅ **知识库与对话打通（RAG 闭环）**：评估报告 `sti-harness-readiness-report.md` 判定的三条承重墙之一 —— 知识库此前是一个**孤立的检索工具**（能在知识库页搜到、能核对出处，却**没有任何办法让对话用上它**）。① **会话挂载知识库**（迁移 `0017_session_kb.sql` 只 `ALTER TABLE agent_sessions ADD COLUMN kb_ids`，存 JSON 数组、**不建外键**、默认 `'[]'` 保证升级后行为不变；上限 **8 个 / 会话**），接口 `POST /api/kernel/sessions/:id/kb`（改挂载）＋ 会话创建 / 详情 / 列表**回显 `kbIds`**。② **注入走"平台侧上下文拼装"，不走工具调用** —— 因为上游 wire 契约**不提供**平台侧工具执行（`assessment-0.11.0.md §B7` 实测），而 0.10.0 的附件正文注入已证明"平台能往 `content` 里写字"这条路成立；于是 `runTurn` 在拼附件**之前**先拼知识：对已挂库检索 **top-k 5**、命中片段合计 ≤ **16KB**、按 `[n] 出处` 排在**用户原文之后**（原文恒在最前）。失败 / 被拒**不打断对话**，只把 `mode` / `notes` 如实回报，前端**照实呈现**。③ **安全线**：**挂载 ≠ 可见** —— 检索侧**永远**按**库级 ACL** 判定（挂载时那次可见性校验只为"当场发现问题"，并**点名拒绝**不可见库）；把库收紧为 `restricted` 后检索结果被 ACL **如实丢弃**（`usedKbIds: []`、卡片写明"都不可访问"），且**区分"权限被拒(403)"与"真的失败"** —— 把正常结果渲染成故障属**夸大**，与隐瞒同样是失真。④ **不挂库时行为与 0.13.1 逐字一致**（不检索、不注入、不加标记）—— 用回归钉住，保证升级**不改变老会话行为**。⑤ **跨端契约**：服务端 `KB_INJECT_BEGIN` ↔ 前端 `WB_KB_MARKER` 一字不差，前端剥注入段改用**通用形态**正则（`<<<大写-{KNOWLEDGE,ATTACHMENTS}>>>`）**一次**切干净（否则"用户原文 + 知识段 + 附件段"三段并存时，知识段会留在气泡里被当成用户打的字）；契约对账**两侧都钉**（`test-core` **扩展**既有"注入标记"用例 + `test-frontend` **新增**一条同款用例 —— 后者是补一处"注释已声称、用例却不在"的**空话**：`kernel.mjs` 那条常量的注释早写着"由 `test-frontend` 的契约对账用例钉住"，而它当时并不存在）。⑥ **顺手修一个发版红线缺陷**：`.gitignore` 的 `data/` **无锚点**，连源码目录 `app/data/`（`db` / `migrate` / `secret` + **17 个迁移** + 4 个仓储，共 **24 个文件**）一起忽略 —— 整个数据层**从未进过版本库**，本次的 `0017` 与仓储改动也提交不进去；改为 `/data/`（**锚定项目根**的那个运行时数据目录）。回归：`test-core` **222/0** · `test-http` **79/0** · `test-knowledge` **34/0** · `test-governance` **49/0** · `test-stream` **22/0** · `test-frontend` **105/0（录制 113）**（共 **511 用例**）；静态审计 **3** 个 0 违规；`gate` 末行 `GATE DONE checks=12/13 skipped=1 fails=0`（**SKIP 仍是"外部内核流式"那一项，不是通过**）；路由 **121**（+1）、迁移 **0017**。⚠️ **本版刻意不做**：rerank、多轮自主检索、跨会话共享挂载 | 剩下的两道墙见评估报告 §3 **阻断一**（智能引擎不在本产品内、接入仍靠手改 `config.json`）与 **阻断三**（模型中心只登记不转发）；工具面见 §4 #4（平台侧工具执行在上游不可用） |
| `0.14.1` | ✅ **真机验收驱动的六个修复**（功能面零变化）：用无头浏览器真实点击走完"初始化 → 登录 → 建库 → 导入 → 挂载 → 提问 → 回放"全旅程，抓出并修复 —— ① **每轮对话后整页渲染冻结**（done 帧附件回执缺 `sent` 字段 → `wbMsgHtml` 读 `at.sent.length` 抛 TypeError → render 崩、DOM 冻结，真机病征是"流式接收中…/停止"永不消失；根因是**前端测试桩里的 done 帧恰好漏了 `attachments` 字段**，与真实形状漂移，bug 完整放过 105 个用例；正修 done 分支补齐四数组 + 渲染层全字段容错 + **桩改真实形状**并加"done 后头部必须收敛"断言）；② **建库后回工作台看不到新库**（工作台单次加载闸挡住重拉 → 知识库五个变更动作成功后置脏 `wbInvalidate()`，切回自动重拉）；③ **成功提示连续显示两遍**（外壳与页面模板各画一次 `State.notice`/`State.error`，账号/用户组/凭据/我的账号/知识库五页中招，页面级重复已删）；④ **纯文本渲染的文案里写 markdown 星号**（8 处：前端 3 + 服务端 notes 5；工具入参里的 prompt 原文**保留**，那是数据层）；⑤ **"＋附件"按钮文字竖排**（flex 压缩 + 可换行，与顶栏按钮同类病因）；⑥ **侧栏导航键盘不可达**（div 无 tabindex/role → 加 `role="link" tabindex="0"` + Enter/空格委托 + 焦点环）。回归：主回归 **511** 全绿（`test-frontend` 105/0 含新增收敛断言）；门禁末行 `GATE DONE checks=12/13 skipped=1 fails=0` | 教训已记入发版 SOP：**桩数据与真实形状漂移 = 测试绿但真机崩**，凡"恒定构造的字段"桩里必须带全 |
| `0.15.0` | ✅ **内核接入向导化（评估报告 §3 阻断一里"配置门槛"那一半）**：此前"接真实内核"唯一的办法是 **SSH 上服务器 → 手改 `data/config.json` → 重启**，而地址里还夹着一个令牌 —— 对企业的 IT 来说这是最典型的"第一天就撞墙"。现在在**概览页**（以及管理员首次登录时的阻断式引导里）三步做完：**粘贴地址 → 检测连接 → 保存并启用（再重启）**。① **检测是独立的一步**，不是保存时顺带做的 —— 它按**用户排查问题的顺序**（地址 → 连通 → 识别 → 鉴权 → 版本）给结论与**可照着做的下一步**，六类失败给**六个不同**的下一步（分类错 = 让人去改没坏的东西）；纯逻辑抽成 `app/kernel/connection-config.mjs`（可穷举回归 + 文案单一真源 `KERNEL_STATE_TEXT`），联网那一步单独留在 `probeKernelConnection`。② **保存前当场证伪**：`unreachable` / 不是内核**默认拒绝保存**（`409` 且把完整诊断一起带回来，走 `ctx.fail` 而非 `throw` —— 统一错误出口刻意只回 code+message）；内核稍后才启动的场景可勾"跳过检测直接保存"，该动作**入审计**。③ **令牌以密文落盘**（AES-256-GCM `dshTokenCipher`，明文键同一事务清掉）：**Windows 上文件权限不可靠**，所以这里选的是"密文"而不是 `0600`；界面、日志、`/api/system/status` 都不回显它。④ 检测与保存都要 **`system:write`**（0.15.0 起管理员具备）：服务端主动去连调用方指定的地址是 **SSRF 形状**，不开给普通登录用户。⑤ **保存成功 ≠ 重启后就是外部内核** —— `effectiveAfterRestart` 照实自报"external / mock（检测未通过）"。⑥ **不改老行为**：不填就还是走环境变量与 `data/config.json` 的老路径，升级后一个字符都不用动。**顺手修两处**：登录页不再向未认证者回显"已建账号 N 个"（那是把"这家公司多大"送给任何能碰到端口的人）；全仓 **69 处** UI 文案里的 markdown 星号字面显示（26 文件 / 68 行，按行白名单 + 机械校验，确认只删了 `*` 字符）。**⚠️ 本版的真机验收又抓出四个缺陷并修掉**（都属"测试全绿但真机不对"）；**发版收口那几步又抓出四件**（都属"**没人报错，所以没人会去看**"）—— 共八件，逐条如下：① **上游产品名随运行期字符串穿透到界面** —— 接入向导里填一个普通 Web 服务，页面显示「该地址有响应，但不像是 DSH（HTTP 200）」；`tools/audit-layering.mjs` 是**源码静态扫描**，看不见运行期，所以审计全程全绿。改为**三道防线**：静态审计（源码层）+ provider 只报**事实**、话由产品层自己拼（设计层）+ `dsh-provider/brand.mjs` 的运行期抹名（兜住上游错误体这类我们控制不了的文本）；并新增一条 **HTTP 级运行期扫描**（代表性接口的响应体里不得出现上游名）—— 它当场又抓出 mock provider 的两处文案。② **「需要重启」是个假警报**：`kernel=auto` 是**解析策略**不是模式，与运行中的 `external` 永远不相等 ⇒ 每个默认部署都常亮一条永不消失的提示；地址里内嵌令牌的历史配置（0.15.0 之前所有部署）同样恒不相等。恒真的提示等于噪声。③ **用量漏账（最贵的一个）**：上游**没有独立的 usage 事件**，用量挂在 `assistant/message` 上，而**记账与汇总两份实现都只认 `type='usage'`** ⇒ 真内核上每一轮都记 0 行、工作台显示"累计 tokens 0"—— 那不是"没数据"，是一句**与事实相反的话**（本轮实测 562 输入 + 6656 缓存 + 2 输出）。合成**单一真源** `app/util/usage-pick.mjs`（任何带 usage 的记录都算；有独立 usage 事件时只认它，避免把一笔账记两遍），并把 `test-external` 里那句「用量可能为 0（上游未回报 usage 时）—— 只要求结构在」的**假前提**改成"**有观测就必须有账**"的交叉核对（假前提把真缺陷写成了预期行为）。④ 工作台「累计 tokens」只加 input+output，**把缓存读漏掉** —— 一轮真实吞掉 7,215 token 的会话显示成 559（少读一个数量级，而那是本平台最想让人看清的数）。**收口时又抓出第五个，性质不同、更该记：发布包里躺着真令牌。** 做法是"**独立解包 → 换一套规则复扫**"——打包脚本自己的扫描**只覆盖 `app/`**，而 `tools/test-core.mjs` 里有一枚**从本机 `data/config.json` 整行抄来的真实内核令牌**（就是给上面第 ② 条写用例时顺手粘进去的），它会**随包分发**，打包却每次报"泄漏 0"。修两条：令牌形态（`?token=<长串>` / `Bearer <长串>` / 私钥块 / JWT）扫描扩到 **`app/ + public/ + tools/ + docs/`**（凡随包出去的目录都扫），并把 **`pack-release.mjs` 本身写成门禁第 14 项** —— "靠发版 SOP 记住跑这一步"不算防线，**人会漏**。⚠️ 同时修掉门禁里一处"静默降级"：`judge()` 原先用 `metric === 'violations' ? … : fails` 的**枚举式**取末行，任何新指标都会被当成 `fails` ⇒ 报"没找到末行"而指错排查方向；改成按 `metric` 动态构造。教训一句话：**扫描范围比扫描规则更容易漏**（规则写得再细，扫不到那个目录就等于没有）。**第六件事是"把这版自己的承诺核一遍"**：本版最大的改进是"令牌密文落盘"，但**在那之前写下的配置不会自己变** —— 老部署的 `data/config.json` 里至今留着一份明文副本（内嵌在地址的 `?token=` 后）。那个形状**不报任何错**（服务照起、对话照跑、页面照显示"已接入"），代价是任何能读到该文件的进程、以及**每一份备份包与快照**都连带拿到了调上游内核的凭据。按本项目自己的纪律（§10 第 14 条：**"不做也不会报错"的运维项必须在自检里有位置**，备份就是先例），补两件：① **自检第 [15] 项「内核令牌落盘卫生」** —— 只**读**配置，报出令牌是密文还是明文（两种明文形状分开说：独立的 `dshToken` 键 / 地址内嵌），并给出可照着做的一条命令；② **`tools/seal-kernel-token.mjs`** —— 就地封存：读出来 → 加密 → 写回，**令牌不经过剪贴板也不打屏**（连地址里那一段也先隐去再显示），默认只报告、`--apply --force` 才写，写前备份、写后**往返校验地址与解密后的令牌逐字一致**；形状**复用** `mergeKernelConfigPatch` 等产品代码，保证"迁移写出来的"与"向导保存出来的"逐字相同。**第八件是门禁自己的一个假绿**：`external` 这一项在"上游不在场"时自报`DONE fails=0 skipped=1` —— 而门禁只认一种 SKIP 拼法（`^SKIP$` 单独一行，那是 `test-external-stream` 的写法），于是**"这次一条都没验收"被记成 ✓**，汇总里的"通过 13/14"也跟着虚高（是上面第 ⑤ 步把配置封成密文、外部验收当场 SKIP 才暴露出来的）。已改为**按末行的结构化字段 `skipped=N` 判**：提示语怎么写都不影响判据，文本匹配只作兜底；`test-external` 也在"一条都没跑"时补上该字段。⚠️ 修的过程中又踩一次同一个坑：第一版从正则**匹配结果**里取"末行"，而它只是 `DONE fails=0` 这一段、不含同行后面的 `skipped=1`，**改红实验里它仍然是绿的** —— 守卫必须看着它红一次。回归：`test-core` **245/0**（+23）· `test-http` **87/0**（+8）· `test-knowledge` **34/0** · `test-governance` **49/0** · `test-stream` **22/0** · `test-frontend` **105/0（录制 113）**（六个主回归共 **542 用例**）；静态审计 **3** 个 0 违规；`gate` 末行 `GATE DONE checks=13/14 skipped=1 fails=0`（14 项 = 0.14.1 的 13 项 + 本版新增的 `packscan`；汇总「用例合计 556」= 主回归 542 + 外部内核 14，**两个口径别混读**）。路由 **121 → 123**（`POST /api/system/kernel/probe`、`POST /api/system/kernel/config`）｜迁移 **0017** 不变 | 评估报告 §3 阻断一剩下的那一半仍是**引擎本身不在本产品内** —— 本版只解决了"接得上"，没有解决"换得掉"；阻断三（模型中心只登记不转发）未动 |

| `0.15.1` | ✅ **交付级真机验收驱动的五个修复（功能面零新增，全属收口）**：按"卖给客户"的标准把四条业务流（组织身份 / RAG 闭环 / 治理 / 运维）在真机各串了一遍，抓出并修复 —— ① **中文整句提问检索 0 命中**：查询按标点切段后段间是 AND，「请问权限管理怎么做的？只回答一句话」这类整句里只要有一段在库里没有双字串，整条查询就判死；`buildQueryLadder` 加 **`any` 档**（全局 OR，放开段间 AND）成四级阶梯 `phrase → or → any → like`，真机钉子钉住"前两档 0 命中、`any` 档必须救回"。② **19 处行内动作用原生 `prompt/confirm/alert`** → **应用内对话框**（新分片 `public/app/15-dialog.js`，前端 **17 → 18 片**）：原生弹窗在 CSP 严格模式与回归垫片里都是死路，且有三类真缺陷——**取消被当成空值**（点"拒绝审批"再点取消 = 以空原因把单子拒了，审计污染）、重置口令**明文回显**、改角色要**手输 role key**。现全部改为 Promise 化的应用内弹层（单选 / 多选 / 口令遮蔽 + 与服务端同规则的强度校验 / 必填不关窗 / 只读密钥展示），`render()` **三个全屏分支都拼弹层**（漏一个分支 = 那个 `await` 永不 settle = "点了没反应"，已双钉）；`decideApproval` 的取消语义修成 `null` 判据。③ **思考过程被当成答案正文**：上游 `content` 是按类型分块的（`reasoning` / `text` / `tool-call`），此前 `assistant/message` 映射全拼成一个串，用户先读到一段英文自我推演；契约层按块类型拆出 `reasoning` 字段（`sanitizeKernelEvent` 同步抹名），工作台思考进"推理过程"折叠区、正文才是答案，**实时与回放共用同一份拆分**（`wbSplitUserText`，两份实现漂移过一次：回放剥了注入段、实时没剥 ⇒ 用户气泡糊进整段资料且原话重复两遍）。④ **多轮历史回放全糊进第一个气泡**（真机抓到）：真实上游的 `turn-start` **不带**用户文本，用户的话由随后的 `role=user` message 事件带来，而 `wbAppendToUserBubble` 从消息流末尾全局找"最近一条用户气泡"、无视回合边界 ⇒ 三轮提问并成一个大杂烩；改为从本条助手块往前扫、**跨过上一回合的助手块即停**。⑤ **用量「按用户」显示裸 ID**（`usr_0mur…`）：治理面板是给人看的对账单，LEFT JOIN users 带出用户名与姓名（已删除用户如实标注）。另修：`createGroup` 提示条写字面 `<b>` 标签（渲染处是 `esc`）+ "操作反馈是纯文本"静态回归钉。回归：`test-core` **246/0**（+1）· `test-http` **87/0** · `test-knowledge` **34/0** · `test-governance` **49/0**（+用户名钉）· `test-stream` **22/0** · `test-frontend` **115/0（录制 113）**（+10：8 条重写为弹层驱动 + 弹层语义 / 渲染分支覆盖 / 实时路径 / 纯文案 / 多轮气泡）—— 六个主回归共 **553 用例**；`gate` 末行 `GATE DONE checks=13/14 skipped=1 fails=0`（汇总「用例合计 567」= 主回归 553 + 外部内核 14）；路由 **123**、迁移 **0017** 不变 |
| `0.15.2` | ✅ **用户真机反馈驱动的三个修复（一页整崩 / 整站无错误边界 / 两栏共一条滚动条）**：① **「契约与映射」点了没反应 = 整页崩**：后端 `compat` 段早已是四态（`verified`/`partial`/`streamSourced`/`refuted`，版本键名 `compatVersion`），前端仍按 `compat.version`/`compat.mapped`/`compat.unverified.length` 读 → `undefined.length` 抛 TypeError；而 `render()` 是"先算 body 再写 `innerHTML`"，异常一抛 innerHTML 就不执行 ⇒ hash 变了、画面纹丝不动（用户感知即"点侧栏没反应"），若落在该 hash 刷新则全站打不开。按后端真实契约重写整页（必选/可选方法、事件类型、规则来源 `bySource`、日志覆盖、兼容基线四态全部呈现），并新增 `arr()` 取值纪律（读不到的字段退化为空态，不许把页面带崩）。② **`render()` 加错误边界**：单页渲染失败降级为"本页渲染失败"提示页，其余页面照常 —— `状态 → innerHTML` 架构必须付的这份成本，早付早省事。③ **外壳布局重做**：`html/body/#app` 锁 100% 高度、`.sidebar` 与 `.content` **各自 `overflow-y: auto` 独立滚动**（此前整页共一条滚动条 + 侧栏 sticky 吸附，长页滚到底要换页得先把鼠标挪回侧栏）；窄屏（≤820px）回退整页滚动。④ **侧栏分组重整**：新增「开发者」组收纳三个自省页（契约与映射 / 接口清单 / 中间件，此前散落在「内核」「平台」两组），9 组按"业务 → 运维 → 开发"排序，组间加分隔线。⑤ 新增**逐路由渲染回归钉**（test-frontend +1）：从路由表源码提取全部 23 页、用真实回放数据逐页渲染，断言标题正确、不触发错误边界、不卡加载态 —— 前后端字段脱节这类缺陷当场现形；内联样式基线 123 → **120**（重写契约页顺手清掉 3 处）。回归：`test-frontend` **116/0（录制 113）**，六个主回归共 **554 用例**；路由 123 / 迁移 0017 不变 |
| `0.15.3` | ✅ **真机浏览器自动化验收纳入常态（门禁 15 → 17 项）**：成本最低、历史收益最大 —— 已连续四版抓到门禁漏网缺陷。① **新增 `tools/test-browser.mjs`（20 场景 / 零依赖 CDP）**：Node 24 内置全局 WebSocket + Chrome DevTools Protocol 驱动本机 Edge/Chrome 无头实例（`--headless=new --remote-debugging-port=0`），从 stderr 截 `ws://` 地址；覆盖四条业务流（组织身份 / RAG 闭环 / 治理 / 运维）：setup→登录→23 页扫荡→建用户→建凭据→登出/成员登录/侧栏收缩/管理员回登→建库→导入→检索→挂库→提问→回放→审批→审计→配额→模型→调度→Webhook→备份→全局 JS 异常对账。② **新增 `tools/audit-coverage.mjs`（覆盖对账）**：页面轴 23 页 × vm 层（test-frontend ALL_ROUTES 锚点）× 浏览器层（test-browser S3 锚点）；接口轴 123 个 API × 测试语料引用（同一行含全部静态段即命中），白名单 2 条逐条注释理由。③ **顺手抓到并修复两个真产品缺陷**：`createJob` 与 `createChannel` 在 `render()` 后才读表单值（render 重建 DOM 把输入清空），UI 上建任务/建渠道永远报「name 不能为空」；`decideApproval` 批准后只刷审批页数据、没刷工作台待办面板，按钮残留。④ **门禁 judge() 已能按末行结构化字段 `skipped=N` 记跳过**（0.15.0 已修），本次 browser 项 SKIP 逻辑与 test-external 同构。回归：`test-browser` **20/0** · `audit-coverage` **violations=0**；`gate` 末行 `GATE DONE checks=15/17 skipped=2 fails=0`（SKIP 仍为 external / external-stream，需真实上游）；路由 123 / 迁移 0017 不变 |

| `0.15.4` | ✅ **用户真机反馈驱动的两个体验修复（侧栏滚动跳变 / 滚动条细线条化，功能面零变化）**：① **侧栏滚到下面点功能，滚动条跳回顶部**：根因是 `render()` 全量重建 `#app.innerHTML`，`.sidebar` 是新 DOM、`scrollTop` 归零 —— 用户滚到下方点功能就得重新滚一遍；修法是重建前读旧侧栏 `scrollTop`、重建后写回（主内容区**不**保持：换页回顶部是预期行为）。② **左右两栏滚动条换成细线条风格**：Windows 原生条又宽又重，两栏各挂一块贴片；新样式轨道全透明、滑块槽位 8px，靠 2px 透明边 + `background-clip: content-box` 让可见部分只有 **4px 的圆角线**，悬停时颜色加深给出"可拖拽"反馈。双通道写法（Chromium/Edge/Safari 的 `::-webkit-scrollbar` 系列 + Firefox 的 `scrollbar-width/scrollbar-color`），全局统一 —— 表格、工作台右栏、弹窗等所有滚动区一并安静下来；只改滚动条本身、不碰容器 padding，内容布局零变化。③ **新增真机回归钉 S21（test-browser 20 → 21 场景）**：侧栏滚到底 → 点非当前页导航 → 断言 `scrollTop` 保持（容差 4px；跳顶是几百 px 的跳变，必红）。vm 层没有真实布局，这类不变式只能钉在浏览器层 —— 与「浏览器验收纳入常态」的设计理由同源。回归：`test-browser` **21/0**；`gate` 末行 `GATE DONE checks=15/17 skipped=2 fails=0`；路由 123 / 迁移 0017 不变 |

| `0.15.5` | ✅ **侧栏信息架构精简（23 → 22 页，功能零丢失）**：对全部页面逐一核对数据对象与操作后的收口。① **「系统状态」并入「平台概览」**：两页本是**同一批数据的摘要版与细节版**（卡片 ↔ 配置来源/数据库/迁移/前端产物明细），并存要记两个入口；现概览页保留状态卡片与内核接入面板，页底新增「系统明细（诊断用）」区，四块明细各包一个**默认折叠的 details**（平台信息与配置来源 / 数据库与迁移 / 前端产物对账 / 原始响应 JSON），样式 class 化（`.sys-details`：边框 + 圆角，summary 悬停变强调色），诊断能力一块不少；旧书签 `#/system` 由路由回落兜底落默认页，不会死页。② **「会话与回合」从「内核」组归位「开发者」组**：它的真实用途是**事件级原始视图**（落库语义事件 / 未知事件排查），日常对话入口是工作台；放内核组会让普通用户误以为是日常入口。③ **测试同步加钉**：test-frontend 逐路由渲染用例新增合并页断言（四块明细标题必须齐全 + system 路由必须消失 + sessions 组必须是开发者），test-browser S3 扫荡与 audit-coverage 页面轴全部 23 → 22。④ 盘点同时确认：身份五页（账号/用户组/角色/凭据/我的账号）主体各异、治理三页与能力三页职责三分、开发者其余三页对象不同 —— 均无重复，不动。回归：`test-frontend` **116/0**（断言增强，用例数不变）· `test-browser` **21/0** · `audit-coverage` **violations=0**；`gate` 末行 `GATE DONE checks=16/17 skipped=1 fails=0`；路由 123 / 迁移 0018 不变 |

| `0.15.6` | ✅ **侧栏分组定序（纯顺序调整，功能零变化）**：把八个组固定为用户指定的顺序「工作台 → 概览 → 知识 → 能力 → 治理 → 平台 → 身份 → 开发者」——日常使用在上（对话 / 概览 / 知识），平台自身管理居中（能力 / 治理 / 平台运维），身份与深度自省在下，开发者组继续收拢全部自省工具。此前身份组凭数组历史位置插在知识与能力/治理之间，把五页管理后台页顶在了日常入口后面。实现上**只调整 `10-routes.js` 里 ROUTES 数组条目的先后**：`navHtml` 按首现顺序推导分组，运行时（`defaultRoute` / hash 解析）全部按 id 查找、无顺序依赖；页面本身、权限要求、hash、页数（22）一概不动。回归：`test-frontend` **116/0** · `test-browser` **21/0** · `audit-coverage` **violations=0**；路由 123 / 迁移 0018 不变 |

| `0.15.7` | ✅ **产品 UI 去开发过程叙事（文案清理，功能与数据零变化）**：本平台是**直接交给部署使用者**的产品，但界面文案里混着大量「开发过程中的自我说明」——里程碑编号、版本承诺、内部决策自白、内部测试术语。本次全部换成使用者视角：① **概览页移除「尚未交付的能力」面板**（PLANNED 空态分支整段自白——「M0~M5 已全部交付……没有验收标准的猜谜，真立项时按 docs/deploy.md 接」——是给开发组看的过程记录，不是给管理员看的产品状态；未交付项将来真出现时，由 PLANNED 驱动的侧栏「尚未交付」组仍是唯一显式出口）；② **里程碑编号全部退出 UI**：概览未实装警告不再写「M3 之前不存在 / M1 的 rbac 兜住」、接口清单页删「里程碑」列与「M0~M5 已全部交付」说明、中间件页删里程碑列（「交付状态」→「状态」，「已实装/未实装」→「已启用/未启用」）、配额页删「需要 M5 的 model gateway」、可见性治理页删「那是 M5 的契约层租户概念」；③ **版本承诺退出 UI**：能力来源页「不属于 0.5.0 的承诺范围 —— 不提前画饼」→「外部市场暂未提供」；④ **内部决策自白与测试术语退出 UI**：OpenAPI「诚实边界……比空着更危险」、契约页「宁可标注不确定，也不假装全知 / 没有验收标准可依 / 早期按文档猜测留下的」、角色矩阵页「整张矩阵在核心回归里被逐格穷举对照」、mock 内核「确定性脚本：用来验证链路与回归」两处；⑤ **保留所有有用户价值的告知**：mock 不是真实模型、规格不是逐字段契约（测试钉的「由路由表生成」「不是逐字段契约」两关键词原样在页）、token 配额是软闸、deny 永远赢、未实装防护环节的如实警告（改为「以下防护环节尚未启用，不产生拦截或审计记录」）。护栏基线 120 → 119（面板删除随之消失 1 处内联 style）。回归：`test-frontend` **116/0** · `test-browser` **21/0** · `audit-coverage` **violations=0**；路由 123 / 迁移 0018 不变 |

| `0.16.0` | ✅ **管理闭环：把「只能看」的页面补成「能管」（界面完整性收口）**：使用者的原始批评是「有的功能只能看不能通过界面配置管理——只能查看的话怎么维护？」。对全部页面逐一核对数据对象与操作后，补齐 8 个缺口。① **配置中心（最大的一块）**：`GET/PUT /api/system/settings`（**17 键白名单**：监听/会话 TTL/向量检索/分块/worker 等；类型强转 + 范围校验违反即 400、错误信息带中文标签；**env 覆盖键直接 400**——env 优先级高于 config.json，允许改只会制造"保存成功却不生效"的假动作；**合并写盘**——只覆盖白名单键，令牌密文 `dshTokenCipher` 等未收录键原样保留，一次保存抹掉内核接入配置是绝对不可接受的）+ 新页**「平台设置」**（每键带来源徽标：环境变量锁定 / config.json / 默认值；被 env 锁定的键禁用并写明原因；22 → **23 页**）。② **六个界面出口补齐**：MCP **登记表单**（POST /api/capability/mcp 本就是 upsert，此前只有命令行能调）、账号页**删除按钮**（DELETE 接口与 `user:delete` 权限一直在，界面没有入口；不给自己渲染）、模型条目**行内编辑**（名称/Base URL/模型名/凭据名/单价；**用途是条目身份不可改**——改用途会让"默认"落空）、会话**改名/删除**（删除级联清事件/附件记录/产物记录/会话行，**用量台账与审批留痕保留**——确认框与响应 `kept` 字段都如实转述边界）、配额**行内编辑**（上限/模式/启用；对象与指标是规则身份不可改）、绑定**行内切换判定**（放行 ↔ 拦截）。③ **四处长描述收进折叠**（只改容器不改文字：MCP 安装行为说明、判定顺序说明、模型页「这是什么」、ZIP 导入提示）。④ **顺手修一个真缺陷**：设置 GET 原读**装配期快照**——保存写盘后页面值"跳回旧值"，管理员会以为没保存成功；改为**实时 `loadConfig()`**（文件 + env 合并），"尚未重启、进程还跑旧值"的边界由 note 与 PUT 的 `restartRequired` 明说。⑤ 测试补齐 + **改红实验**：test-http +7 用例（设置清单/校验/合并落盘、改名/删除、配额编辑、绑定切换）、test-frontend +7 断言组（新表单与按钮渲染、App 方法对账、平台设置页），录制补齐 4 条接口（settings/MCP 登记/建账号/补录会话与绑定清单——**回放数据非空，行内按钮才测得到**）；改红实验双确认：破坏白名单键 → 设置用例红、破坏 `data-act` → 会话页用例红，还原后全绿。回归：`test-http` **94/0** · `test-frontend` **125/0（录制 120）** · `test-browser` **21/0** · `audit-coverage` **violations=0**；路由现读 **129**（public 8 / session 67 / admin 54；本版新增 GET/PUT `/api/system/settings`、PUT `/api/governance/quotas/:id` 三条。⚠️ 此前版本行沿用的「路由 123」与 `--check` 现读不符——手抄沿用的旧计数失真了 3 条没人发现，路由数自本版起一律现读、不再沿用）/ 迁移 0018 不变 |

| `0.16.1` | ✅ **过程叙事二次清剿（0.15.7 的复查收尾，功能与数据零变化）**：0.15.7 清过一轮后使用者复查仍抓到漏网 —— 本次对 public/ 界面字符串与 app/ 接口下发文案做**系统性全量扫描**（里程碑编号 / 版本承诺 / 开发术语 / 「如实」「尚未接通」类过程腔），共清 10 处：① 工具策略页「边界（如实）：…M5 的 model gateway 会把这条边界收掉」→ 只留事实边界，删掉里程碑承诺；② 配额空态「（如实空态，不是加载失败）」→ 直说「平台当前不限制任何用量」；③ Skill 来源「市场（后续版本）」→「市场（暂未提供）」（与同页 0.15.7 已改口径对齐）；④ 接口清单副标题「已交付与计划中各占一行」→「逐行可查」；⑤ 工具执行不可用说明「策略会被如实登记」→「策略仍会登记」；⑥ 工作台内核行「内置确定性 mock，用于演示与回归」→「内置演示模型（非真实模型，仅用于体验流程）」（「回归」是开发术语，用户价值告知保留）；⑦⑧⑨ 附件三处下发文案（回合 skipped note / 上传 delivery.note / 语义说明 other）里「上游本意是只读路径、该通路本平台尚未接通」的机制解释与将来承诺全部删除 → 只留「不会送给模型，仍被登记、可查看与下载」；⑩ 工作台附件提示同步。区分原则不变：**如实标注现状（mock 不是真实模型、guess 是未核实、防护环节未启用）保留**，开发过程与将来计划退出 UI。回归：`test-http` **94/0** · `test-frontend` **125/0（录制 120）** · `test-browser` **21/0**；路由 129 / 迁移 0018 不变 |

| `0.16.2` | ✅ **拆除「平台主动发起工具执行」功能族（0.16.0 管理闭环后的反馈）**：使用者的反馈是「模型只能在对话中自己调工具，平台主动发起工具执行——当前真实内核不可用，删掉所有平台主动发起工具执行的相关功能及其描述，所有相关的」。本次**整体拆除**该功能族：后端删除 POST `/api/kernel/sessions/:id/tools/:name` 网关路由、`tool_policies` 策略表管理、`approvals` 审批模块与队列、`approval.pending` 通知事件、`approval.expire` 调度任务、权限资源 `approval`；前端删除审批页/待审批工作台面板/工具策略表/工具执行横幅与相关文案；测试同步删除全部审批用例、审批门用例、工具执行探测用例，治理测试改由服务层直接造数（`recordFromToolCall`）钉住产物留存链路；路由 **129 → 124**（删 5 条）、页面 **23 → 22**（删审批页）、场景 **21 → 20**（删 S13 审批流）。保留路径不动：「模型在对话中自发调工具」的 upstream 回合内概念（契约方法 `listPendingApprovals`/`respondApproval`）、产物留存（`artifacts` 数据源改为回合事件流 `ev.tool` 投影）、mock 脚本的 `tool-call`/`tool-result` 事件序列。回归：`test-http` **93/0** · `test-frontend` **122/0（录制 114）** · `test-browser` **20/0** · `test-core` **242/0** · `test-governance` **43/0** · `audit-coverage` **violations=0**；路由 124 / 迁移 0018 不变 |

| `0.17.0` | ✅ **生产就绪收口（交付前评审驱动）**：按「交付给真实生产环境」的标准做全量评审后逐项落地 —— ① **两步验证（TOTP）**（迁移 `0019_totp.sql`）：登录分两步（凭据通过发**短时票据** → `POST /api/identity/login/totp` 交动态码或恢复码）；自助五条路由（状态 / 开启 / 确认 / 关闭 / 重生成恢复码）+ 管理员 `identity.users.totp-reset`（**不动口令、不吊销会话**的轻处置）；恢复码 HMAC-SHA256 哈希落库、**每张只能用一次**、明文只出现一次、**不能用恢复码换出新恢复码**；防重放（成功步号 CAS 写 `last_used_step`）；**未开启者登录路径逐字不变**。② **CSV 批量导入用户**（表头 `账号,口令,姓名,部门,角色`；逐行独立；报表带行号与原因且**不回显口令**；每个建出账号逐条入审计 `via:import`）。③ **会话导出 md/json**（**注入段剥离并注明**；只认这两种格式）。④ **部门改名 / 删除**（改名校验与创建一致、重名检查排除自己；删除带**引用护栏**：先成员后子部门、人话拒绝，不制造悬空引用）。⑤ **工作台会话改名 / 删除入口** + 删「会话与回合」开发者页。⑥ **企微 / 钉钉通知信封**（host 精确匹配 / `errcode === 0` 判定 / 不支持加签如实标注）。⑦ **UI 质量批次**（≤1100px 右栏可达 / 对话框 Tab 焦点陷阱 / 消息流 aria-live / 登录页回车提交修复）。⑧ 运维与安全文档补齐（deploy.md 运维缺口 + `security-review-2026-10.md` + docs/README 归属表）。回归（现读）：`test-core` **261/0** · `test-unit` **32/0** · `test-http` **109/0** · `test-knowledge` **34/0** · `test-governance` **43/0** · `test-stream` **22/0** · `test-frontend` **158/0（录制 134）** · `test-browser` **22 场景/0** · `test-external` **12/0**（用例合计 **671**）；`gate` 末行 `GATE DONE checks=16/17 skipped=1 fails=0`。路由 124 → **135**（public 9 / session 72 / admin 54）、页面 22 → **21**、迁移 **0019** |

| `0.18.0` | ✅ **管理界面出口补齐（C1~C5）与三个产品缺口（E1~E3）**：承接 0.16.0 的「把只能看的页面补成能管」，把评审剩下的五处「后端接口早就在、界面没有出口」一次补完 —— ① **用户组改名 / 改说明**（`PUT /api/identity/groups/:id`，`group:write`）；② **用户姓名编辑**（`PUT /api/identity/users/:id` 本就接受 `displayName`）；③ **调度任务行内编辑**（沿用既有的部分更新 `PUT /api/schedule/jobs/:id`）；④ **通知渠道行内编辑**（只提交「名字 + 订阅事件」，**URL 留空 = 不改动** —— 避免"保存时把密钥清掉"，空名当场拦住不发请求）；⑤ **会话日志补 `log.zip` 下载出口**（接口自 0.5.0 起就在，但此前前端零引用 —— 工作台的指路文案还指向一个并不存在的页面；本版新增「会话日志」页把指路牌兑现）。三个真正的产品缺口按「**删除 / 改名类动作界面先说清楚再动手**」的纪律补齐 —— **E1 Skill 卸载**（`DELETE /api/capability/skills/:name`：zip 来源**连安装目录一起删**；`local` 引用与越界路径只注销登记、**不碰用户目录** —— 响应如实说明未删原因；未登记与重复卸载均 404；不可逆，想留着请用停用）；**E2 知识文档改名**（`PATCH /api/knowledge/documents/:id`：只动显示字段、**不重新解析**（`chunkCount`/`status` 不变），需**该库** write 档（服务层判定），变更独立入审计 `knowledge.document.rename`）；**E3 备份文件删除**（`DELETE /api/operation/backup/:file`：新权限键 **`operation:delete`** —— 不可逆删除单独一档、管理员显式具备（默认档不含 delete，不能靠通配符顺带给出）；形态白名单 `backup-*.zip`、**绝不删最后一份**（409）、连带清理一次性密钥侧车；确认弹层显式声明不可逆）。回归（现读）：`test-core` **261/0** · `test-unit` **32/0** · `test-http` **109/0** · `test-knowledge` **34/0** · `test-governance` **53/0** · `test-stream` **22/0** · `test-frontend` **188/0（录制 150）** · `test-browser` **22 场景/0** · `test-external` **12/0**（用例合计 **711**）；`gate` 末行 `GATE DONE checks=16/17 skipped=1 fails=0`。路由 135 → **138**（public 9 / session 73 / admin 56）、页面 21 → **22**（新增「会话日志」页）、迁移 **0019** 不变 |

| `0.19.0` | ✅ **工作台增强（试用反馈驱动：模型区 / 可用能力面板 / 安全渲染）**：① **登记模型 provider 补全** —— 此前已登记模型在工作台模型下拉只显示条目名、provider 取不到（dsh-console 都能显示）；现按 provider id 前缀推导补齐 shim 推导规则，`test-unit` 加钉子；② **去掉「外部内核 / 内置内核」产品说法** —— mock 只是开发过程，不是与真实内核并列的产品形态；界面只讲「已接入 / 未接入内核」（0.15.7 开启的"过程叙事退出 UI"原则延伸到内核接入文案）；③ **模型区整合** —— 工作台模型下拉与已登记模型列表同步显示（「未登记模型」与「未知来源」本是同一个问题，统一呈现）；④ **工作台右栏「可用能力」面板** —— 技能 / 工具 / 插件 / MCP 四段如实呈现：已登记未探测到的技能给**差距行**、上游无工具清单 RPC 时如实标注、MCP 健康探不了如实 `unknown`；无 `skill:read` / `mcp:read` 权限时整面板不渲染；⑤ **自家渲染器增强** —— 助手正文走**安全 markdown 子集渲染**（新分片 `public/app/79-wb-render.js`，插在 71 与 80 之间）：escape-first（先整体转义再做格式变换），标题 / 列表 / 引用 / 代码块 / 行内代码 / 粗斜体 / 链接子集；`javascript:` 链接退化为纯文本、原始 HTML 永远字面输出；工具卡入参 / 结果 JSON 富格式（短内联、超 280 字符折叠）。回归（现读）：`test-core` **261/0** · `test-unit` **36/0** · `test-http` **109/0** · `test-knowledge` **34/0** · `test-governance` **53/0** · `test-stream` **22/0** · `test-frontend` **192/0（录制 150）** · `test-browser` **22/0** · `test-external` **12/0**（用例合计 **719**）；`gate` 末行 `GATE DONE checks=16/17 skipped=1 fails=0`（skipped 为 `external-stream`，无真上游、SKIP 不计入通过）。路由 **138** / 页面 **22** / 迁移 **0019** 不变 |

| `0.20.0` | ✅ **清单与调用的口径：可用 ≠ 已用（工作台「实际调用」+ 工具卡来源对账）**：工作台右栏与「能力清单」页摆的都是**清单**（登记表 + 内核探测），而"这一轮到底用了什么"是**事件流事实** —— 两者此前从不相遇。本版把它们对上：① **右栏新增「实际调用」段**，逐行列出真跑过的工具，每行带**来源对账徽标**；② **工具卡来源三态**（`wbAttributeTool()`）：登记工具表命中 → 仅内核探测到 → 未登记（上游未报告来源）；③ **三条口径都不许省**：**只做精确同名匹配、不按名字前缀猜血缘**（上游 `tool/call` 事件里根本没有来源字段，把 `fs.read` 认成"来自 MCP 服务 fs"能造出看起来像事实的结论）、**假差距不许凑**（内核工具清单为空是"上游没有这个 RPC"，如实标注 `toolsNote`，此时**不**把登记表整个列成"未探测到"；只有两侧都报了东西差距行才成立）、**权限的投影不是事实**（没有 `skill:read` 时「实际调用」与工具卡来源徽标**整块不渲染**，否则每个工具都会被标成"未登记"，读起来像"这些工具非法"）；④ **刻意不新增** `/api/capability/tools` 只读端点 —— 工具登记表搭在 `/api/capability/skills` 响应里，前端一次加载两份清单**同源同口径**、也不增加契约面的覆盖率对账面；契约层**刻意没有加** `tool.source` 字段（恒为 null 的字段只会制造"字段在、事实无"的假象）。回归：与本批收口同批实测（**在途版本，未单独记数**，收口数见 0.21.6 行）。⚠️ **迁移 `0019` → `0020`**（`0020_custom_roles.sql` 建 `role_grants` 表：一行 = 一个「角色 × 资源 × 动作」授予）—— 但该表**当前没有任何消费方**：判定层仍只认 `ROLE_MATRIX` 的四个内置角色，也没有「建自定义角色」的接口（身份模块只有 `GET /api/identity/roles`）。**本版只落了表结构，自定义角色的授权路径尚未接通**，列为待收口项（迁移注释里设想的 `CUSTOM_GRANTABLE` 白名单函数同样未实现）。路由 **138** 不变 |

| `0.21.0` | ✅ **对话工作台改版：工作区树 + 访问档 + 模式与推理等级（迁移 0021）**：左栏从**一条扁平会话列表**换成**工作区树**（工作区 → 会话 → 「未分组」桶），并补齐输入卡的模式与推理等级选择器；参考对象是原生 Harness 的界面。两条口径先立：① **工作区不是上游实体**（实测上游没有工作区 RPC，只有 `workspace/archiveSession` 这类会话级归档）—— 它是**纯平台侧的组织概念**，平台从不向上游同步工作区；删工作区只删组织容器、**不级联删会话**（会话 `workspace_id` 置空落回「未分组」，审计记 `detachedSessions`）；② **工作区是纯组织容器，"谁能做什么"由组织角色说了算**（当时平台上还挂了一套三档权限 + `open`/`restricted` 可见性 + 工作区级授权名单，**已在 0.21.6 整块删除**）。档位从**会话能力**推导（`full ← session:delete` / `write ← session:execute` / `view ← session:read` / 未知 → `none`，**fail-closed**），不新造 `workspace:*` 资源 —— 档位的本义就是"能对**会话**做什么"，新造资源等于让平台同时维护两套"谁能干什么"的真相；`admin` 因此在 `permissions.mjs` 里**显式**拿到 `session:delete`（它不是给某条路由用的，删会话仍是 `session:write`，它的第一语义就是"完全权限"这一档本身）。**权限判定分两层**（与库级 ACL §6.1 同一条）：路由层只到 `session:read` / `session:write`（**档位判定后移**，否则判定不会发生在它该发生的那一层），服务层 `assertWorkspaceAccess` / `assertSessionAccess` 判"这个人能不能动这个工作区 / 这条会话"，档位不够一律 **403** 并点名当前与所需档位。**推理等级首次落库**（`agent_sessions.reasoning_effort`，此前只透传、**重启即丢**；它记的是"平台**要求**上游用的等级"，不是从事件里观测到的实际等级，与 `model_id` 的既有口径一致）。**模式来自内核**（上游只回 `id` / `order` / `isDefault`，**没有名称与描述** —— 名称是显示层的事，平台**不发明**内核没有的模式；上游不可用如实返回 `unavailable` 而不是 500）。**会话 `cwd` 继承工作区**（显式传以显式为准）。回归：与本批收口同批实测（**在途版本，未单独记数**）。路由 138 → **146**、迁移 0020 → **0021** |

| `0.21.1` | ✅ **行内「⋯」、判定同源、初始化就有默认工作区**：0.21.0 把树建起来了，但每一行把动作**摊在面上**（工作区行：新建 / 改名 / 权限 / 删除；会话行：改名 / 删除），行本来就窄，按钮一多工作区名与会话名先被挤没 —— 用户原话是"重命名、删除等按钮隐藏到一个工作区名称或者会话名称右侧，点击再弹出来"。本版只做三件事，都是把 0.21.0 的骨架**收口**，不加新概念：① **行内「⋯」菜单 —— 菜单是状态，不是 DOM 浮层**：开合状态就是 `State.wb.rowMenu` 这一个值，**不引入任何浮层节点**，与全站"重绘即真相"同一条纪律（没有独立显隐生命周期，也就没有"状态里有、DOM 里没有"这种第二份真相），因此它**能被 vm 层回归直接驱动** —— 浮层的定位、遮挡、`z-index`、滚动跟随在 vm 层测不到，用一个状态换掉一整类测不到的东西；**互斥天然成立**（一个 `rowMenu` 只能指一行，点空白顺手收起 `40-delegate.js` 的 `!el` 分支），**不误触外层**（事件委托取**最近的**带 `data-act` 的祖先，点菜单项不会顺手打开会话或切工作区）。② **判定同源**：0.21.0 有个真实风险 —— 列表按全局 `session:write` 亮按钮，而动作守卫按工作区档位放行，会出现一个**点了必然 403** 的按钮（用户读作"系统坏了"）；修法不是把两处逻辑对齐一遍（那会漂），而是**只留一份判据** `sessionManageRight`（`kernel.sessions.list` 用它回填 `canManage`、`kernel.mjs` 的 `guardWsOwnership` 用它放行，`manageRightsFor` 是它的批量版，按「`workspace_id` × 是不是我的」去重；未分组会话 `need: null` 恒定放行）。③ **初始化就有默认工作区 —— 空树不是可接受的初始态**：两个入口各播一次且都**幂等**（初始化向导走完 `ensureDefaultWorkspace`；启动时 `ensureDefaultsForAllTenants` 覆盖升级上来的空库），**幂等靠"已有工作区就一步不动"**（第二次启动不会多建、不会改名、更不会把用户改过的 `cwd` 覆盖回去），**播种失败不许把成功的初始化搞成失败**（向导里 try/catch 成一句 `workspaceNote`，照常 201），与 `schedule.ensureDefaultsForAllTenants` 同形（只在实际服务模式做，`--check` 保持只读）。**`cwd` 默认值不写死**（`paths.mjs` 推 `DATA_DIR/workspace`，可被 `STI_WORKSPACE_DIR` 覆盖；刻意**不用 `process.cwd()`** —— 那会把"从哪儿敲的命令"变成一条持久配置）；更新时加**长度校验**（> 512 → 400，因为 `cwd` 决定上游项目级能力能读写哪一片文件系统）。顺带把模型与推理等级**同排到输入卡**（此前模型在 `wb-head`、等级在输入卡，两个"这个会话用什么"的选择器分居两处）。回归：与本批收口同批实测（**在途版本，未单独记数**）。路由 **146** / 迁移 **0021** 不变 |

| `0.21.2` | ✅ **工作台改全屏视图 + 样式收口（用途：把嵌套层级问题变成不是问题）**：0.21.0/0.21.1 的工作台仍是 `.content` 里的一张圆角卡片，顶上挂全站 `.topbar`、左边立全站 `.sidebar`，三栏工作台再套进这两层外壳，真正留给对话的宽度只剩几百像素 —— 布局的"乱"不是配色问题，是**嵌套层级**问题。改为**全屏分支**（`render()` 里 `fullBleed = cur.id === 'workbench'`，**别处一行没动**）：`#app` 直接是 `body + dlgOverlay()`，不套 `topbar()` / `.layout` / `.sidebar`，形态对齐"进门即工作台"。配套细节：① **左栏三段固定 + 一段滚动**（品牌头 → 「工作区」节头 → **树（唯一滚动区）** → 底部管理后台/设置/账号条），`.wb-tree` 是 `flex:1 1 min-height:0`，树自己滚、头部与底部不动；② **底部账号条不是装饰，是补一个真实缺陷** —— 「登出」此前**只存在于顶栏**，工作台变全屏后不再渲染顶栏，于是**进了工作台就再也登不出去**；整屏改动砍掉既有能力是不可接受的，这条**被真机层抓到**（`test-browser` S6：成员登录后停在无权限地址 → 回落落地页 → 那里找不到 `[data-act="logout"]`）—— 结论：**把一页改造成"另一套外壳"，等于把原外壳承载的**全部**能力重新落一遍**；③ **输入卡分层**（徽片在卡外 `.wb-chips`、模型/等级/圆形 `↑` 发送钮在卡内 `.wb-card-foot`、附件与归因徽标在左下），分工判据是**"是不是事实核对"**；下拉箭头用 CSS 内联 SVG data URI 画，**不引任何资源文件**；④ **三处空态噪音改成不渲染**（知识库条 / 附件条 / 消息流在"什么都没有"时一律 `return ''`）—— 空态不解释，是这次改动的自洽选择；⑤ **检索从"横幅"改成"浮层"**（绝对定位，由 `⌕` 切换）、过滤框与右栏**默认收起**、默认落进第一个工作区、未分组空桶**不渲染**；⑥ **图标不能随便挑符号**：「插件」原用 `⌗`（U+2317）Windows 中文字体里**没有字形**，真机渲染成豆腐块，换 emoji `🧩`（该入口 0.21.6 已删，教训留着：凡是要"看起来像个图标"的字符，先想清楚字体有没有字形）；节头三个钮都补 `title`。回归：与本批收口同批实测（**在途版本，未单独记数**）。路由 **146** / 迁移 **0021** 不变 |

| `0.21.3` | ✅ **内核热切换：保存即生效（改掉本产品一句错误的自我限制）**：此前界面上写着"内核连接是进程级配置，保存后需要重启"，代码里的理由是"内核门面在装配期被路由持有，热切换会让'正在跑的回合用的是哪个 provider'不可判定"—— 这句话一半是**事实**，一半是**把当时的实现形状说成了不可逾越的约束**。拆开只有两条：① **门面形状（可改）**：`facade()` 原先是对象字面量（`mode`/`provider`/`reason`/`dshStatus`/`contract` 全是**值属性**），"换内核"只能重来一遍全装配而路由表持有旧对象；改成内部持 `state` + 对外**全 getter** + 一个 `swap(next)` 之后，换内核 = **原子写一次 state**（门面引用不变、`deps.kernel` 不用重接、所有调用点下一行就拿到新值）—— 这正是"改成 getter"是这里唯一正确形状的原因：它让改动量等于**零**，而不是等于"调用点数"。② **在途回合（真问题，但有确定答案）**：一轮对话跨 `submitTurn` 与 `streamTurns` 两个 await 点，做法是**在回合开头抓一次 provider 局部变量**（`routes/kernel.mjs` 的 `turnKernel`）整轮都用它 —— 切换前已开始的回合用**旧**内核跑完、切换后新发起的回合用**新**内核，于是语义从"不可判定"变成**可判定**，"切内核不打断正在进行的对话"从一句愿望变成一条实现（被换下的 provider 不需要关闭：上游客户端是纯 `fetch`、会话日志是 `statSync` + 一次性读取，只是内存对象）。③ **两处"看起来无关、其实换不掉"的绑定必须一起拆**：`server.mjs` 的 WS 桥处理器在 `createServer` 时抓了一次（换内核后实时流仍从**已经不该再用**的那一个来）→ 改成在 `upgrade` 事件里**现取**；`runTurn` 里的三处 `kernel.provider.*` → 见 ②。④ **与首次装配同构**：切换走 `reloadKernel`，与启动装配**共用同一个 `gated()`**（能力闸漏在任一路径上都会出现"换完内核后被停用的工具又回来了"这种只有切换过的进程才有的怪状态），并且**重新 `loadConfig()` 读盘**（保存是直接写文件的，不重读就会"换了等于没换"）；令牌在**副本**上解密、成功后才回写内存（`unlockKernelToken` 在"已有令牌"时直接返回，所以**必须先显式回落再解锁**，否则点"清空令牌"时会留着上一次的明文）。⑤ **仍然要重启的两种情形必须继续说重启**：环境变量覆盖（`DSH_ORIGIN` 优先级最高，文件改了进程不变）、重新装配抛错（如实报"已保存但切换失败，仍用原内核"）—— **拿一个新的谎言去替换旧的缺陷，比留着旧缺陷更糟**。⚠️ **本版最大的坑在装配层**：新增 deps 能力 `switchKernel` 时测试脚手架没注入，接口会**如实降级**成"需重启"，于是"保存即生效"这条路径在回归里**静默测不到**（断言照样全绿）—— 少接一根线不会报错，只会让断言测了个寂寞。回归：与本批收口同批实测（**在途版本，未单独记数**）。路由 **146** / 迁移 **0021** 不变 |

| `0.21.4` | ✅ **内核两态与「模式」概念删除（迁移 0022）**：`selectKernel` 只按"配置里**有没有地址**"分叉 —— ① **没地址** → 占位 provider：**每个契约方法都抛 `kernel_not_configured`、绝不返回"看起来正常的空结果"**；② **有地址但连不上** → 如实报不可用。随之整个删掉"内核模式（mock / auto / external）"这个**概念**：`/api/health`、`/api/system/status`、`/api/kernel/status` 一律报 `ready` **布尔**，不再有 `mode`；内置 mock 内核移出 `app/kernel/`（回归用的确定性替身落到 `tools/kernel-stub.mjs`）；**迁移 `0022` 删掉 `agent_sessions.kernel` 列**。0.21.3 ④ 那条"保护性判断"（`auto` + 探测失败属于"计划外降级"，此时**保留原内核不切**）也随之失效并删除 —— 它保护的对象是**内置 mock 内核**（`auto` 探测失败会降级到它，"降到 mock"意味着界面显示正常、实际拿不到真实回答），保护对象不存在了，**剩下的只有一句更简单的话：保存什么就是什么**。同时**版本门禁穿过真实 provider** 而不是字面量（"没有上游版本时不得报出『上游版本未验证』"—— 从前靠"内核模式 = mock 就跳过门禁"盖住，模式删了就得由 provider 自己如实报空）。另：**未接入内核时的整页阻断**（`pageKernelGate`）落地 —— "每个渲染分支都必须拼 `dlgOverlay()`"这条不变式多了一个成员；`sessionStorage` 从 vm 沙箱里删掉（"记住本会话关过引导"那个机制随可关闭弹窗一起没了，留着只会让下一个"没声明的全局"静默通过）。回归：与本批收口同批实测（**在途版本，未单独记数**）。路由 **146** / 迁移 0021 → **0022** |

| `0.21.5` | ✅ **内核接入界面收敛成一屏 + 保存必须以"检测通过"为前提**：未接入内核时的阻断页曾经有四五屏（内核是什么、平台哪些功能不依赖它、为什么整页拦住、可核对项表格、保存回执、切换语义两条须知…），而这一页面对的人是**第一次把平台跑起来的管理员**：他手里已经拿着内核启动打印的那一行，需要的是"粘哪儿、点哪个键"—— 四屏解释之后真正要做的两件事被埋在中间。收敛成**一屏**，并把两件"说不动人只好解释"的事改成**不用解释**：① 从前要写一段"保存即生效…只有 env 覆盖才需要重启"→ 现在保存成功**当场关闭**并进首页，**行为本身就是答复**；② 从前要写"为什么保存键是灰的"→ 现在灰键旁边一句话"先点检测"，而"**跳过检测直接保存**"这个选项本身已删掉。细节给**概览页**那张接入面板留着（`kernelProbeCard(p, compact)` / `kernelFormHtml(pfx, compact)`）—— 那里的人是运维、正在排查一次接不通，可核对项对他有用；同一个组件两种形态，判据是"这一屏上的人此刻要做什么"，而不是"哪个页面更高级"。两条随之而来的**收紧**：① **保存必须以检测通过为前提**（`force` 旁路删除）—— 它唯一的作用是把一条当场已被证伪的配置存进去，换到的是"保存成功、平台却没接入上"，那是最难自查的一种失败（界面显示"已保存"）；前端把保存键置灰是**把话说在前面**，服务端同样按这个前提拒（它会自己重探一次，非 ok 一律 **409** 且带回**完整诊断**）；② **改动输入即作废上一次的检测结论**（否则"先探一个好地址、再改成另一个"就能绕过上一条），作废时重绘一次并把**焦点与光标放回原处**（`resetKernelProbeOnEdit`）—— 这条路径每次输入都会走，丢焦点的手感比灰一个按钮糟得多。另钉住：**待重启判定只剩地址一个客观量**（"模式"这个概念整个消失）。回归：与本批收口同批实测（**在途版本，未单独记数**）。路由 **146** / 迁移 **0022** 不变 |

| `0.21.6` | ✅ **工作区权限整块删除 + 左栏结构收口 + 落脚会话（迁移 0023）**：① **整块删除"工作区权限"**，触发点是用户的一句判断 —— *"dsh 原生有工作区权限三档；这块如果没有接口操作 dsh 原生工作区权限，这块的权限没有什么意义 —— 这块设置了，原生的 dsh 又没办法改。"* 核对下来这是**结构性**的事实：真实内核 21 个契约方法里与"权限"沾边的只有 `listPendingApprovals` / `respondApproval`（那是**工具调用审批**，走事件流、事后可见，**不是 RPC**），契约快照里搜 permission / approval / sandbox / mode **全部无结果** —— 平台这份是**第二份真相**，而平台**没有任何接口去改上游那一份**。结论落在：**一份改了不生效的权限配置，比没有权限配置更糟**（它让人以为已经管住了，比"明确不管"危险得多，因为会改变人的谨慎行为，且不出错时毫无迹象）。删除面：数据（`workspaces.visibility` 列 + `role_bindings` 里 `scope_type='workspace'` 的绑定，**库级与租户级绑定不动**）、判定（`decideWorkspaceAccess` / `visibleWorkspaces` / `normalizeWorkspaceVisibility` / `maxLevel` / `ADMIN_ROLES`）、服务（`listGrants` / `grant` / `revokeGrant` / `verdictFor`）、路由（三个 `/grants` 端点，路由 **146 → 143**）、界面（7 个动作 + 授权面板 + 档位徽片 + 输入卡上方的工作区下拉）。⚠️ **门禁没有消失，消失的是"这个工作区单独授权"这一层**：`levelFromRoles` 仍是档位的唯一来源（输入只剩组织角色）、路由层仍由 `session:read`/`session:write`/`session:execute` 把守、`assertWorkspaceAccess` 签名与语义几乎不变（内核路由三处调用点**一个字没改**）；从前那张**五条优先级的判定顺序表整段塌掉**、收敛成一行 `levelFromRoles(角色)`，**不需要也没有新造替代机制**。⚠️ **一处语义确实变了**：「看不见的工作区 → 404」消失（工作区对全组织可见，404 只剩"真的没有这个 id"一种含义），回归里因此加反向断言 —— **member 改工作区必须是 403 而非 404**。② **左栏结构收口**：删左栏顶部「✦ 新会话」胶囊（与工作区行的「＋」重复，且"建在哪儿"只有一种正确答法）与「🧩 插件」（插件是平台管理面的事）；工作区行尾的常驻徽片换成 **`⋯`（重命名 / 删除）在左、`＋`（新会话）在右**，两个动作**鼠标划过才现身**（CSS `:hover`）—— 树是靠名字读的，不是靠一排图标；工作区菜单五项收窄到两项；未分组桶行尾只剩 `＋`；输入卡上方的工作区下拉**删除**（它与左侧树是两个改同一件事的入口，写入口重复时界面没法回答"到底哪个算数"）。⚠️ 一个 **CSS 选择器陷阱**：`.wb-menu-open > .wb-row-more` 是**子**选择器，而 `⋯` 现在包在 `.wb-row-ops` 里，不同步改成**后代**选择器菜单一打开 `⋯` 就跟着隐掉（用户看到"点开菜单后按钮消失了"）。③ **落脚会话：新装的平台不该是一棵空树** —— 初始化时在默认工作区里放一条空会话，用户第一反应是"这东西坏了"而不是"我要先建一个会话"。它是**一条只在本地库里的会话**（`kernel_session_id` 为空），**刻意不在播种时调上游建会话**（播种可能在内核接好之前，而 0.21.4 起未接入内核时上游直接拒答，硬建会得到一条"**看起来建成了、其实没有上游会话**"的假记录）；约定因此是**本地会话行是平台侧的身份，上游会话按需建立**（第一次真要用它时 `requireSession` 当场补建并把 id 写回）—— 从前这里直接 409「该会话没有关联的内核会话」，用户看到的是一条**能打开却发不出消息**的会话，那是个解释不出来的死胡同。**幂等判据是"全平台零会话"而不是"这个工作区零会话"**：后者会让每一个被用户清空过的工作区在**每次启动**时都重新长出一条（往人家的地里反复塞东西）；零会话才是"从没被用过"的唯一诚实判据。④ **迁移纪律**：`0021` 一个字都不能改（`migrate.mjs` 做 sha256 比对），删列只能**新增** `0023_drop_workspace_permission.sql`。⑤ **一条测试自洽教训**：`test-core` §B10 断言"自检第 [14] 项配齐后是 `ok`"，而那一项会去读**环境**里的备份密钥（`STI_BACKUP_KEY` → `data/backup.key` → 都没有则 `warn`），于是用例结论随"本机 `data/backup.key` 在不在"漂移（没清过库的机器上绿、把库重置成"刚解压"的机器上红）—— 一条**假红**；修法是让用例自己**钉住那个输入**（显式设 env 并还原），**不是**去放宽断言（判据：**用例的结论不该由环境决定**）。**回归（现读，本批收口实测）**：`test-core` **265/0** · `test-unit` **36/0** · `test-http` **124/0** · `test-knowledge` **34/0** · `test-governance` **54/0** · `test-stream` **22/0** · `test-frontend` **206/0（录制 152）** · `test-browser` **22 场景/0** · `test-external` **12/0**（用例合计 **753** = 六个主回归 705 + unit 36 + external 12）；`gate` 末行 `GATE DONE checks=16/17 skipped=1 fails=0`（skipped 为 `external-stream`，无真上游、SKIP 不计入通过）。路由 **143**（public 9 / session 78 / admin 56）/ 页面 **22** / 迁移 **0023** |
| `0.21.7` | ✅ **界面收口：一套图标、一个展开入口、一个绑定项、一条轴**：本版没有新概念，全部是**把已有的东西对齐** —— 三处修错、一处删、两处把"两个东西"并成一个，逐条对应人的原话。① **图标"有大有小难看"的根因是字体**：此前的"图标"是一个个 Unicode 散字（`⇤ ⌕ ⟳ ＋ ⋯ ▾ ▸ 📁 ▦ ⚙ ▤ ⊕ ↑ ⌫`），它们出自不同的字体块、**基线各异**（同一个 `font-size` 排出来就参差），语义还得靠猜；更要紧的是 **`⌗`（U+2317）在 Windows 中文字体里没有字形**，真机渲染成豆腐块 —— 那不是难看，是没渲染。改法是一套 **17 键的内联 SVG**（`WB_ICONS` + `wbIcon()`）：同一 16×16 视口、同一线宽、`stroke="currentColor"`（主题翻转自动跟随），尺寸只由 `.wb-ico` / `.wb-ico.sm` 定，零资源文件、不做请求；**表情符号也一并换掉**（`📁` / `🧩` 是彩色位图，字号一变大小就跟着变、各平台画风还不同，与第 1 条同类病）。② **左栏收起后再也展不开（真缺陷）**：收起钮住在 `.wb-side` 里，而 `.wb.side-closed .wb-side{display:none}`把整栏连钮一起藏掉 —— 界面上**再也没有可达的展开入口**，只能刷新页面。修法是认清"入口不能与它操作的容器住在同一个被隐藏的子树里"：展开钮渲染在 `.wb-side` **之外**（主区左上绝对定位），两颗钮调**同一个** `wbToggleSide`。回归因此钉**结构**（`<aside class="wb-side">` 那一段里不许出现 `wb-side-expand`）而不是钉"有按钮"——按钮住在栏里时它也"有"。③ **「模型未归因」：应当把两者并成一件事**。用户问"右侧选择哪个模型会话就绑定哪个模型不行吗"，核对下来他说得对：归因真源是 `agent_sessions.model_id`，而发回合的请求体**根本不带模型**（只有 `content` + `attachmentIds`）——所以"选择器显示什么"与"会话绑了什么"不一致时，**用户看到的模型就不是真正在用的那个**，而那颗徽标只反复提示"没归因"、给不出出路。做法不是再补第三个概念，而是**并成一个**：新建会话时随 body 提交、打开会话时按选择器**补绑**一次（失败静默 —— 只有 `session:read` 的角色会 403，那不是错误状态而是权限事实，弹红条只是噪音）、选模型时立即登记。补完 `选中的 ≡ 绑定的`，徽标无事可报 → **删除**；`modelRecorded` 与成本报告里的"未归因"桶**都保留**（账本的事实不该被界面回避）。④ **会话内检索与清屏：整块删除**（用户裁定"整块删除"，不是只摘按钮）：路由 `kernel.sessions.search` + 仓储 `events.searchEvents` + 前端 5 个动作（含 `wbReset`）+ 结果面板 + 命中高亮 + 4 个 State 字段 + `#wb-q` 回车监听 + CSS + 三处测试一起清掉；注释里留了它当时的口径（服务端搜而非前端过滤、按"可见文本"复核掉只命中结构化字段的假阳性、`LIKE` 通配符转义、归属校验走 `sessions.getSession`）。⑤ **右栏「实际调用」/「可用能力」删除，事实不丢**：对账口径（精确同名、**不按前缀猜来源**、三态、`toolsNote` 假差距不许凑）仍在**能力清单页**与工具卡的**来源徽标**上生效，`wbAttributeTool` / `wbCatalog` 与 `w.caps` 拉取**全部保留**（徽标要用）；回归把原用例里验徽标的那段摘出来单独保留，并改成**逐个工具卡各取一个 head**（原版只取第一个，工具一多就漏），另加两条反向断言。⑥ **新建工作区：cwd 从"盲填"改成"看得见地选"**。`cwd` 是**服务器上**的路径，手打的两个结局是"打错"或"打对但不知道那是什么目录"；浏览器也给不了服务器目录树（`webkitdirectory` 拿到的是**客户端**目录，且只能得到 `C://fakepath//…` 这种假路径，存下去就是一个不存在的位置）。新增**只读**的 `GET /api/workspaces/browse`（`platform/workspace/browse.mjs`）：**它不增加任何能力** —— `workspace.create`（`session:write`）本来就接受**任意** cwd 字符串，能建工作区的人早就能把 cwd 指到服务器任何一处，所以挂**同一个门**，只把"盲填"变成"看得见地选"；边界：只列目录不列文件、路径先 `realpathSync` 归一（解析 `..` 与符号链接）、不递归（因此无成环风险）、`MAX_ENTRIES=500` 上限并如实标 `truncated`、读不了 **400**（带 errno）与不存在 **404** 分开报；⚠️ `ENOTDIR` 两处抛（`realpath` 与 `readdir`）**归同一个码** —— 同一个原因给两个状态码是最难查的一类不一致。界面侧 `Dlg.browse` 同样是**状态**（`State.dlg`，因此 vm 层能直接驱动），交互只有"点进去 / 退出去"，**不做路径输入框**；返回值**三态**：路径 / `''`（不设工作目录，**有效选择**）/ `null`（取消）—— 判取消只能用 `=== null`；另有拦阻：路径还没读出来就点确定，不关窗、不发请求（否则空串会被当成"没给 cwd"，**静默建出一个没有工作目录的工作区**）。⑦ **宽度与居中**："对话框太窄"与"正文两边容距太小、没居中"其实是两个问题：前者把 `--wb-compose-w` 从 `min(780px, calc(100% - 48px))` 放宽到 **900px**；后者是消息流此前**横跨整个主区**而输入卡居中收窄 —— 两截不在一条轴上。修法是给消息流套一层 `.wb-stream-inner`，`max-width` 取**同一个变量**。⚠️ 一个自定义属性陷阱：原来把 `calc(100%)` 写进了 `--wb-compose-w`，而 **`100%` 是在"使用它的那个元素"上解析的** —— `.wb-compose-wrap` 与 `.wb-stream-inner`（父元素带内边距）会解析出两个不同的值，"同宽"在同一次渲染里根本不成立；所以该变量改成**纯长度**，两侧留白交给各容器自己的 `max-width`。⚠️ 还有一条**最容易被忽略的必要条件**：消息流是**滚动容器**而输入卡不是 —— 内容一超长，滚动条就吃掉内容盒右侧宽度、把居中的正文列整体推走半个滚动条宽（本项目 8px → 偏 4px），于是同一个缺陷在**短对话里看不见、长对话里必然出现**；`.wb-stream` 加 `scrollbar-gutter: stable both-edges` 让内容盒相对内边距盒恒对称，中心不再随滚动条出现与否漂移。⚠️ 另一条不变式：`.wb-stream-inner` **只在有内容时渲染** ——`.wb-main.is-empty .wb-stream:empty{display:none}` 靠的正是 `.wb-stream` 自身为空，无条件套一层它就永远不为空、空态会白占一块高度（正反两条钉子都进了回归）。⑧ 节头那一行：过滤与新建改成**划过才现身**，⚠️ 用的是 **`opacity`**而不是 `display:none`/`visibility:hidden`（后两者会让按钮**从 Tab 序列里消失**，键盘用户就再也够不到"新建工作区"），并补 `.wb-sec-head:focus-within` 一条；「重新拉取工作区与会话列表」入口**整个删掉**（树自己会重拉，手动刷新是多余且容易误判的入口 —— 点了没变化时用户会以为"坏了"；`wbEnsureLoaded` 本身仍被那些路径调用）。**回归（现读，本批收口实测）**：`test-core` **265/0** · `test-unit` **36/0** · `test-http` **124/0** · `test-knowledge` **34/0** · `test-governance` **54/0** ·`test-stream` **22/0** · `test-frontend` **209/0（录制 151）** · `test-browser` **23 场景/0** · `test-external` **12/0**（用例合计 **756** = 六个主回归 706 + unit 36 + external 12）；`gate` 末行 `GATE DONE checks=16/17 skipped=1 fails=0`（skipped 为 `external-stream`，无真上游、SKIP 不计入通过）。路由 **143 → 143**（−1 会话内检索、+1 目录列举；public 9 / session 78 / admin 56）/ 页面 **22** / 迁移 **0023** 不变 |
| `0.21.12` | ✅ **工作台三视图收口 + 工具登记表删除 + 全面大清理（迁移 0024 / 0025）**：本版是 `0.21.8`~`0.21.12` 一整个在途批次（对应用户 2026-10-08 逐条给出的界面裁定）与一次**全仓同步 + 门禁全量重跑**的合并收口。① **「未分组」整个删掉（迁移 0024）**：它不是一条工作区记录，只是 `workspace_id IS NULL` 的会话构成的**虚拟桶** —— 没有 id、没有 cwd、不能改名、不能删除，所以各处呈现必然不一致；更要紧的是权限：`sessionManageRight` 对未分组的会话**直接返回 `can:true`** —— 进了工作区的会话按档位判，没进工作区的反而**人人可管**，这是个没有门的暗门。换成：删工作区时里面的会话**移入默认工作区**，因此默认工作区**不可改名、不可删除**（它是全租户会话的兜底去处；`workspace.create` 的 409 与界面上那两个动作的消失是同一判决的两面）。② **工具登记表整表删除（迁移 0025）**，用户原话：「工具是在内核自己调用，不用单独写这个能力，而且不会单独列出来有哪些工具」—— 三条事实支持它：平台侧没有任何工具执行路径（0.16.2 已拆）、上游 wire 契约里**没有工具清单 RPC**（`tools/list` / `capabilities/tools` / `pluginInventory/tools` / `tool/list` 实测**全 404**）、工具只以 `tool-call` / `tool-result` 事件的形式**事后**出现。于是"工具"与 Skill 的根本差别成立：**Skill 是平台可治理的能力**（有安装流程、有文件落位、有登记表、能逐个启停），**工具不是**。⚠️ 本次最需要小心的一步是 **MCP 闸改成走自己那套判定** —— 它此前**复用了工具判定函数**（`toolVisibleNow('mcp:'+name)`），删掉工具判定时必须给它一条独立的路，否则 MCP 的可见性会跟着工具一起消失。③ **工作台改双视图：正文与轨迹分开**。消息流一侧**只留正文**（加上唯一一处刻意的例外：错误），工具卡 / 推理 / 用量 / 附件回执 / 注入回执 / 原始事件**全部搬进「轨迹」页签**；轨迹页签属于**主区**而不是右栏。随之一并处理的：**推理过程用 `<details>` 收起**、**工具卡 JSON 富格式**、**附件回执移出聊天视图**（回归里配一条反向断言 —— 聊天视图里**不许**出现回执）。④ **三个真实缺陷在这一批被抓出并修掉**（都是回归"全绿"时仍存在的）：㈠ **流被截断时整段内容丢失** —— `wbMessagesFromEvents` 用"还没进过第一个回合"（`!inFirstTurn`）丢开头噪声，而它是循环内的**后置**量，在"这条流从头到尾没有 `turn-start`"时**恒为 false**，于是**每一条事件都被当成噪声丢掉**，`msgs` 回来是空的；修法是**进循环前先预扫**（`hasTurnBoundary`）—— "这条流有没有回合边界"是**整条流**的属性，不能等到循环里才知道（此前 `sawTurnStart` 那个豁免只说明"到此刻为止见过"，同样不成立）。㈡ **孤儿块判据过宽** —— 打开一条老会话时会看到一个**空气泡**（用户 2026-10-08：「每个会话最开始的闪烁的 `wb-caret.idle` 直接删掉」）；`wbStreamHtml` 的 `if (!seenUser) continue` 只看"前面有没有用户气泡"，而正确的判据是"孤儿"**且**"没有任何可显示内容"，两个条件缺一不可 —— 补 `wbMsgHasContent(m)`，它**复用渲染层同一份拆分**（正文 / 错误），所以"有内容"与"会不会画出来"是同一件事，不会两处漂移。㈢ **`listPlugins` 从未登记进契约**：0.21.10 把 `listTools` 更名成 `listPlugins`、真实 provider 实现了它、路由层在消费它，但 `contract.mjs` 的 `required`、测试替身、未接入占位三处**都还写着旧名** —— 契约核实的 `extra` 里一直挂着 `listPlugins`，而"清单接口下发工具段"这条判据**从未真正验过**。⑤ **两个"静默测不到"的覆盖空洞被门禁抓出**：㈠ **MCP 可见性的那套判据此前恒绿** —— 内核替身把 `listMcpServers()` 硬编码成 `{servers: []}`、DSH provider 的 `mcpServers()` 是过期的"未实现"桩，于是"停用一个 MCP 服务 → 它从契约层消失"这条**断言永远是绿的**（因为清单本来永远是空的）；修法是让 MCP 清单来自**平台登记表**（`listMcpServersAcrossTenants`），并把 reader 穿过**全部三条装配路径**（首次装配 / 热切换 / 测试脚手架）。㈡ **`/api/governance/artifacts/open` 一条 HTTP 用例都没有** —— 覆盖对账把它抓了出来；这个接口是本项目**唯一一处会把用户给的字符串交给进程创建**的地方，补的四条用例里有一条**静态钉住实现形式**（必须 `spawn` + 数组传参 + `shell:false`，不许出现 `exec`）—— 那种东西注释守不住，只有断言守得住。⑥ **迁移纪律的一次真违规被修复**：`0001_init.sql` 曾被**就地修改**（把 `tools` 表的 CREATE 换成一句"此表已删"的注释），这是拿 sha256 硬比对当摆设 —— `migrate.mjs` 校验和当场不认（`770f9e5a21c3e74e` → `2a3f80cdf4ea2e55`），本机库直接拒绝启动。修法是**逐字节还原**（从 `dist/sti-harness-0.21.7.zip` 里取原件，因为手抄回来的 `tools` 表定义 checksum 对不上），并把"新装没有 tools 表"这件事的**属主**交给 `0025`（**已应用的迁移一个字都不能改**，删表只能新增迁移）。⑦ **界面收口（`0.21.8`~`0.21.11` 已落地部分）**：左栏收起后改**左侧竖排入口栏**（`.wb-siderail`）—— 0.21.7 那颗"住在被隐藏子树之外"的孤钮换成了一整列，`wb-side-expand` 类名保留（真机层的锚点不变）；管理动作全部收进**行内「⋯」菜单**；节头过滤与新建改 `opacity` 方案（**不许用 `display:none`** —— 那会把按钮从 Tab 序列里摘掉）；图标统一为**内联 SVG**；新建工作区的 cwd 改成**文件夹选择弹框**（只读的 `GET /api/workspaces/browse`，`realpath` 归一 + 不递归 + 上限 500 + `truncated` 如实标注 + 读不了 400 与不存在 404 分开）；消息流与输入卡**同轴**（`--wb-compose-w` 必须是**纯长度** —— 写进 `calc(100%)` 会在两个不同父元素上解析出两个值，"同宽"根本不成立）+ `scrollbar-gutter: stable both-edges`（滚动条出现与否不该推动居中列）。⑧ **门禁的浏览器一项如实改成 SKIP 档**：本机 Edge **装是装了但驱动不了无头实例**（`msedge.exe --headless=new …` 与 `--headless --dump-dom about:blank` 都是**退出码 0 且零输出**，stderr 从不出 `DevTools listening on …`，本机也没装 Chrome）。此前的写法把它记成 `fails=1` —— 那是让**机器决定门禁成败**，用久了唯一后果是这条门禁被人习惯性忽略，那它守着的 23 个场景就全白写了；现在与"找不到浏览器"同档：**SKIP 并写明原因，绝不计入通过**。**回归（现读，本批收口实测）**：`test-core` **266/0** · `test-unit` **36/0** · `test-http` **125/0** · `test-knowledge` **34/0** · `test-governance` **59/0** · `test-stream` **24/0** · `test-frontend` **226/0（录制 148）** · `test-browser` **23 场景（SKIP）** · `test-external` **12/0**（用例合计 **782** = 六个主回归 734 + unit 36 + external 12）；`gate` 末行 `GATE DONE checks=15/17 skipped=2 fails=0`（跳过项为 `browser` 与 `external-stream`，均**不计入通过**）。路由 **143**（public 9 / session 78 / admin 56）/ 页面 **22** / 前端分片 **19** / 迁移 **0025** |

> **关于「M2 拆两刀」的决策变更（记录原因，便于回溯）**：
> `feasibility.md` §2.3 原建议把 M2 拆成「部门级可用版里的精简 M2（纯 Node + bigram + 降级）」与
> 「完整企业版里的外部解析 + 向量」两刀交付。实际施工后**没有拆**，理由有三条：
>
> 1. **向量那一路的抽象与 FTS 那一路是同一层的**（都在 `retrievers/`，都要过 RRF、都要过隔离过滤）。
>    拆开做等于把接口设计两遍，第二遍必然要返工第一遍；
> 2. **「无 embedding 自动降级」这条验收标准要求两条路都存在**（要能对比"当前是哪种模式"），
>    只有纯 FTS 的话，"降级"无从谈起 —— 它会变成"本来就这样"；
> 3. 实际投入没有超出预估：外部解析适配器是**探测 + 调命令**（探测不到就如实降级），
>    不是"实现 PDF 解析"；工作量的大头在分块与检索，那部分两刀都躲不掉。
>
> ⚠️ 但**原判断的风险意识是对的**：M2 确实是四个里程碑里最重的一个。
> 因此额外产出了 `docs/benchmark.md`，把**规模边界**（10 万可用 / 20 万开始吃力 / 50 万必须换方案）
> 白纸黑字写下来，而不是留到线上才发现。


> 版本号单点维护在根目录 `VERSION` 文件（沿用 dsh-console 的约定）。
> **迁移链必须连续**：升级不得跨大版本跳迁（feasibility §7.4）。

---

Copyright 2026 liwei（易智瑞西安）.
