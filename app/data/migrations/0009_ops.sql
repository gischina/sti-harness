-- ---------------------------------------------------------------------------
-- 0009 · 运维闭环三件套（P1-2）：定时任务 / 出站通知 / 审计链尾锚点
--
-- 为什么需要（三条都是"自己承诺过但没做"，不是"为了功能数量"）：
--   ① **没有任何东西能"按时间跑"**。全仓的 `setInterval` 只出现在限流清扫与流心跳 ——
--      于是审批超时、审计归档、审计锚定、定期备份、模型探活巡检这五件事
--      **全都没有落脚点**，只能靠人记得手动点。企业运维的第一条要求就是
--      "该定时做的事不需要人记得"。
--   ② **平台没有任何主动告知能力**。配额被拦、审批积压、备份失败、探活失败 ——
--      全靠人主动打开页面看。异常不主动找上门，等于没有告警。
--   ③ **审计链只防"事后改一行"，防不了"整表重写"**。0001 起就把这条边界写在
--      audit.mjs 顶部，M5 承诺过外发链尾 hash 但没做。链尾锚点是这条边界的
--      唯一出路：把「当日最后一条 hash + 记录数」落到**平台控制不到的地方**
--      （只读文件 / 出站副本），整表重写才会露出破绽。
--
-- 隔离说明：
--   三张表**全部带 `tenant_id`**，因此 `tools/audit-tenant-isolation.mjs`
--   的静态扫描会覆盖它们（按「迁移里是否有 tenant_id 列」推导清单）。
--   这是刻意的：三类数据都是"某个组织自己的运维资产"，按组织隔离才是正确语义。
--
-- 只增不改（迁移纪律）：
--   · 不新增 `notify_deliveries` 表 —— 投递记录走**审计链**（每次投递入链），
--     渠道行上只留 `last_*` 三列做"最近一次"快照。理由是投递明细天然属于
--     "谁在什么时候把什么发了出去"，这正是审计该回答的问题；另建一张表
--     只会让同一件事有两个真相。
--   · `scheduled_jobs.kind` 是**执行体白名单的 key**（见 platform/schedule/tasks.mjs），
--     不是自由文本 —— 库里出现一个没有实现的 kind，调度器会如实报
--     `unknown-kind` 而不是静默跳过。
--
-- Copyright 2026 liwei（易智瑞西安）.
-- ---------------------------------------------------------------------------

-- ── 定时任务 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  -- 人类可读标识，租户内唯一
  name             TEXT NOT NULL,
  -- 执行体 key。白名单：approval.expire | audit.archive | audit.anchor
  --                    | backup.create | model.probe
  kind             TEXT NOT NULL,
  -- 触发规则，两种形态（**不实现 cron 解析器**，理由见 platform/schedule/service.mjs）：
  --   'interval:<毫秒>'      例如 interval:3600000（每小时）
  --   'dailyAt:HH:MM'        例如 dailyAt:03:00（每日 UTC 03:00）
  schedule         TEXT NOT NULL,
  params_json      TEXT NOT NULL DEFAULT '{}',
  enabled          INTEGER NOT NULL DEFAULT 1,
  -- 上次执行：时间 / 结果（ok | fail | skipped）/ 明细（执行体自己回报的结构化信息）
  last_run_at      TEXT,
  last_status      TEXT,
  last_detail_json TEXT NOT NULL DEFAULT '{}',
  -- 下次执行时间。**由调度器算出并写回**，让页面能直接显示"下次什么时候跑"，
  -- 而不是让前端再实现一遍同样的计算（那一定会与后端算出不同的结果）。
  next_run_at      TEXT,
  run_count        INTEGER NOT NULL DEFAULT 0,
  fail_count       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
  ON scheduled_jobs(tenant_id, enabled, next_run_at);

-- ── 出站通知渠道 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notify_channels (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  -- 渠道类型。**只实装 webhook**；email / sms / 企微机器人等一律不写进这里假装支持
  -- （要加就在 platform/notify/service.mjs 的 SINKS 白名单里加一个真会发包的实现）。
  kind            TEXT NOT NULL DEFAULT 'webhook',
  -- ⚠️ URL 是**加密存放**的：出站 URL 里经常内嵌 token（如钉钉/企微机器人
  --    的 ?access_token=…），它等价于一个密钥。接口只回显 host，不回显完整 URL。
  url_cipher      TEXT NOT NULL DEFAULT '',
  -- 若目标用 `Authorization: Bearer`，把凭据名放这里（值在 credentials 表加密）。
  credential_name TEXT NOT NULL DEFAULT '',
  -- 订阅的事件白名单（JSON 数组）。空数组 = 不订阅任何事件（渠道存在但不发）。
  events_json     TEXT NOT NULL DEFAULT '[]',
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_delivery_at TEXT,
  last_status     TEXT,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_notify_channels_tenant ON notify_channels(tenant_id, enabled);

-- ── 审计链尾锚点 ────────────────────────────────────────────────────────
-- 每天一行：把当日最后一条审计的 hash 与记录数固定下来。
-- ⚠️ 诚实边界（必须写进文档，否则会给出虚假的安全感）：
--    锚点只有在**离开这台机器**时才有意义。落一张同库的表只是便于页面展示与
--    人工核对，它防不了"有库权限的人连锚点表一起改"。真正的防篡改需要
--    ① 锚点文件落在只读挂载/异地介质，或 ② 通过 notify 出站把锚点发到外部。
--    平台把两件事都做了（写 data/anchor/*.json + 可选出站），但**不假装
--    主表与锚点在同一台机器上就等于防住了**。
CREATE TABLE IF NOT EXISTS audit_anchors (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  -- YYYY-MM-DD（UTC）
  day          TEXT NOT NULL,
  tail_hash    TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  file_path    TEXT NOT NULL DEFAULT '',
  anchored_at  TEXT NOT NULL,
  UNIQUE (tenant_id, day)
);

CREATE INDEX IF NOT EXISTS idx_audit_anchors_tenant ON audit_anchors(tenant_id, day DESC);

-- ── 审计链基准（归档后仍可校验的关键）────────────────────────────────────
-- ⚠️ 这张表解决的是一个**必须解决的**正确性问题，不是可选优化：
--   哈希链的每一行都记着 `prev_hash = 上一行的 hash`。0001 起 `verifyChain()`
--   从 `prev = ''` 开始重算 —— 一旦"审计归档"删掉了最旧的若干行，
--   剩余第一条的 `prev_hash` 仍指向**已被删除的那一行**，
--   校验会在第 0 行就报"断裂"。也就是说：**不加这张表，归档动作本身
--   就把审计的可校验性打破了**，而这是比"没归档"严重得多的后果。
--   基准（base_hash）把"被归档掉的那段的链尾"固定下来，作为剩余链的起点：
--   write 用 last-row 的 hash（无行时用 base_hash），verify 从 base_hash 开始重算。
--   归档动作会同时更新 base_hash，并**把这次归档本身写进链**（可追溯）。
CREATE TABLE IF NOT EXISTS audit_chain_state (
  tenant_id    TEXT PRIMARY KEY,
  -- 已归档段最后一行的 hash。'' 表示从未归档过（此时链起点就是空串）。
  base_hash    TEXT NOT NULL DEFAULT '',
  -- 已归档的记录总数（用于向外部核对"我们删了多少、锚了对少"）
  archived_count INTEGER NOT NULL DEFAULT 0,
  archived_at  TEXT,
  updated_at   TEXT NOT NULL
);
