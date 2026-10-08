-- 0016 通知投递失败重投队列（体检报告 §B5）
--
-- 为什么要这张表：在它之前，出站通知是**纯 best-effort** —— 有界重试（2 次、250ms 退避）
-- 之后失败就只剩一条审计记录，**没有任何重投**。后果是"上游抖动 = 告警永久丢失"，
-- 而丢掉的恰恰是 `audit.anchor`（审计链尾锚点，用于把锚点带出这台机器）、
-- `backup.failed` 这类**必须被看见**的事件。对生产来说这是硬伤，不是取舍。
--
-- 设计上的四条纪律（都在 service 里有对应实现，改这张表时请一起读）：
--   1. **记录的是"意图"而不是"HTTP 请求"**：存 event + payload + channel_id，
--      重投时重新解密 URL、重新做 SSRF 校验。绝不缓存已解析的 IP ——
--      主机名的解析结果会变（DNS 重绑定），只在写入时判一次等于把安全边界钉死在过去。
--   2. **渠道名冗余存一份**（`channel_name`）：渠道被删掉之后，这条记录仍然要能说清
--      "当初是发给谁的"。历史记录不该因为有人删了一个渠道就变成一行无主的 id。
--   3. **刻意不加外键**到 `notify_channels`：与审计同一条纪律 ——
--      删渠道不该被历史投递记录挡住，也不该级联删掉"曾经失败过"这个事实。
--   4. **payload 落库**：它进的是本机 SQLite（与审计同级），不是外部网络。
--      但调用方**不要把凭据放进 payload** —— 这条边界写在 service 的 emit 注释里。

CREATE TABLE IF NOT EXISTS notify_deliveries (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  channel_name    TEXT NOT NULL,
  event           TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  -- pending：等待重投（含首次失败）；delivered：重投成功；dead：超过上限，**保留可见**可手动重投。
  -- 刻意没有"retrying"这个中间态：它是进程内的一次执行，不是持久状态 ——
  -- 写成状态就得处理"进程崩在中间"的孤儿态，而 at-least-once 本来就是 webhook 的语义。
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_status     INTEGER,
  next_retry_at   TEXT,
  first_failed_at TEXT NOT NULL,
  last_attempt_at TEXT,
  delivered_at    TEXT,
  created_at      TEXT NOT NULL
);

-- 重投的取数路径：`status = 'pending' AND next_retry_at <= now`。
-- 没有这个索引，每次重投都要全表扫 —— 而被重投的表恰恰是"上游一直不通"时增长最快的那个。
CREATE INDEX IF NOT EXISTS idx_notify_deliveries_due
  ON notify_deliveries(status, next_retry_at);

-- 列表页按租户 + 时间倒序
CREATE INDEX IF NOT EXISTS idx_notify_deliveries_tenant
  ON notify_deliveries(tenant_id, created_at DESC);
