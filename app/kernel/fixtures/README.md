# fixtures —— 真实上游事件流（脱敏）

这个目录存放**从真实上游录制的会话事件流**，用途只有一个：
**在宁可"看起来没问题"也要抓到"字段静默失效"的地方，用真实数据把映射钉死。**

## 为什么它不是可选项

我们有三层防线，强度递减，**缺一层就有一类问题看不见**：

| 防线 | 能看到什么 | 看不到什么 |
|---|---|---|
| `upstream-contract.snapshot.json`（类型定义快照） | 事件类型名、字段名变了 | **结构**变了；插件自有事件；运行时根本不赋值 |
| **本目录的 fixtures（真实事件流）** | 上面全部，外加：内容块结构、`data` 层级、插件事件、枚举取值、空值模式 | 上游没跑到的分支 |
| `events.mjs` 里的别名猜测 | 我们**以为**的形状 | 一切没猜中的东西 |

第三层单独存在是很危险的。项目初期就是这么干的，结果实测发现**三处会静默失败**：

1. `tool/result` 的真实字段是 `data.message`，我们只找 `result`/`output` → **工具结果全部为空且不报错**；
2. `message.content` 是**内容块数组** `[{type:'text',text:'…'}]`，不是字符串 → 只认字符串的话**所有消息文本全丢**；
3. `turn/end.data.reason` 是**对象** `{kind}` → 直接取文本得到 `null`，**结束原因静默丢失**。

这三处都不会抛异常、不会打日志，只会让界面「安静地少点东西」。这就是 fixtures 的意义。

## 文件说明

| 文件 | 内容 |
|---|---|
| `dsh-<版本>-session.json` | 从该版本上游的会话日志录制的事件流（已脱敏、已裁剪） |

结构：

```jsonc
{
  "meta": {
    "upstreamVersion": "0.2.0-rc.2",   // 这条 fixture 属于哪个上游 —— 缺了它就没法判断是否过期
    "sessionFormatVersion": 4,
    "sourceSha256_12": "…",            // 来源指纹（不存路径，避免泄漏本机目录）
    "observedTypes": ["turn/start", "…"],  // 这份数据里真正出现过的事件类型
    "typeCounts": { "tool/call": 3, "…" },
    "redaction": [ "…脱敏规则逐条…" ]
  },
  "events": [ /* 原始事件，内容已替换为占位 */ ]
}
```

## 脱敏规则（"结构 100% 真实，内容 0 泄漏"）

- **保留**：事件信封（`type`/`seq`/`time`/`surfaceOp`）、一切数字与布尔、数组长度与元素结构；
- **保留**：枚举型键的值（`type`/`kind`/`role`/`status`/`reason`/`preset`/`mode`/`policy`/`provider`/`model`/`isError`/`origin`/`agentPreset`/`lang`/`operation`/`shape`/`form`/`version`）；
- **替换**：id 类键 → `"<id>"`；其余字符串 → `"<text:N>"`（N = 原字符数，**保留长度**，所以"字段还在但变空串"也测得出来）；
- **不存**：原始文件路径。
- 数字里包含**时间戳与 token 用量**，它们原样保留 —— 前者需要、后者正是要测的数据。

## 怎么录制 / 更新

```bash
node tools/record-fixtures.mjs --list      # 看本机有哪些会话日志
node tools/record-fixtures.mjs             # 录制（默认挑最大的那个会话）
node tools/record-fixtures.mjs --per-type 3 --max 300
```

数据来自上游自己的会话日志（**不需要浏览器令牌**）：

```
<DSH_HOME 或 ~/.dsh>/sessions/<projectKey>/<sessionId>/session.vN.jsonl.zstd
```

那是**拼接的 zstd 帧容器**（首帧 header，其后每帧一个事件批次），
所以录制工具按魔数切帧逐帧解压 —— 直接用流式解压器会在第二帧报
`Unknown frame descriptor`（踩过）。

## 什么时候必须重新录制

- 上游升级后（**与 `snapshot-upstream-contract.mjs` 一起跑**，两者互补）；
- 发现轨迹页出现「未知事件」时；
- `node tools/test-core.mjs` 里 fixtures 用例失败时 —— 它断言的是
  「每条真实事件都被识别，且命中的规则是**已核实**的」。

## 纪律

- **不要手改这些 JSON**。脱敏规则在脚本里；手改会让"这是真实结构"这一唯一价值失真。
  要改就改脚本然后重新录制。
- fixture 里**不允许**出现真实路径、命令、聊天内容。加新字段时先想一遍：
  "这个字符串会不会带上用户的东西？"——会，就进脱敏名单。
