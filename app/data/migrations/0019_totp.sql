-- ---------------------------------------------------------------------------
-- 0019 · TOTP 两步验证（2026-10 安全评审 §4.1）
--
-- 三张表，对应两步验证生命周期的三个阶段：
--
--  1) user_totp —— 每个用户至多一行。
--       · secret_enc：TOTP 密钥（Base32）经 AES-256-GCM 加密后的 v2 信封
--         （`identity/credentials.mjs`，主密钥在 data/.secret）。**不存明文** ——
--         库文件泄漏不构成"能离线生成验证码"的攻击面。
--       · enabled_at IS NULL = 已登记（begin）但尚未验证通过（confirm）；
--         确认时才写时间戳。未确认的登记可被再次 begin 覆盖（用户扫错了二维码等）。
--       · last_used_step：最近一次成功校验的 30 秒步序号（RFC 6238 T 计数）。
--         校验必须严格大于它 —— 同一窗口（或更早窗口）的码不能重复使用，
--         否则被肩窥到的一个码在窗口期内就是一张可重放的通行证。
--         管理端重置会整行删除（**不动口令**），用户可重新登记。
--
--  2) user_recovery_codes —— 一次性恢复码（手机丢了、验证器数据没了时的退路）。
--       · 每码一行，code_hash = HMAC-SHA256(masterSecret, 归一化后的码)。
--         与令牌（tokens.mjs）同纪律：用带主密钥的 HMAC 而不是裸 sha256 ——
--         恢复码熵有限（人类可抄写长度），拿到库也不能离线穷举比对。
--       · used_at：用过的码即时作废（一次性）。重新生成时整批替换。
--
--  3) login_challenges —— 两步登录的"第二步票据"。
--       · 第一步口令通过后签发，第二步验证 TOTP/恢复码时出示；
--         与 auth_sessions 同纪律：落库的只有 ticket_hash（HMAC），不存明文。
--       · 为什么落库而不是进程内/无状态：单次消费（consumed_at）、尝试计数
--         （attempts，配合账号退避限制 6 位码的爆破速率）与过期（expires_at）
--         都是**跨请求状态**；放进程内则服务重启即清零（与 0018 P0-4 同一教训），
--         无状态签名则做不了"这条票据已被用过"。
--       · 每次"口令验证通过"会作废该用户旧票据（见 service.mjs）——
--         同时最多一条待验证票据，旧的一次性凭据不再滞留。
--
-- 三条纪律：
--   1. **不建外键到 organizations**：与 login_lockout 同 —— 删组织时残留行
--      由清理任务负责，不让一条挑战记录挡住组织删除。
--   2. **user_id 带 REFERENCES users(id)**：与 auth_sessions 同 —— 删人时
--      必须由 deleteUser 显式清理（外键默认 RESTRICT），步骤固定、可数。
--   3. **不缓存、不过期到未来**：expires_at 是绝对 ISO 时间；判定处
--      `String(expires_at) > nowIso()` —— 与库中其它过期字段同口径。
--
-- 只增不改（迁移纪律）：新增迁移，不动历史迁移。
--
-- Copyright 2026 liwei（易智瑞西安）.
-- ---------------------------------------------------------------------------

CREATE TABLE user_totp (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  secret_enc     TEXT NOT NULL,
  enabled_at     TEXT,
  last_used_step INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE user_recovery_codes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_recovery_codes_user ON user_recovery_codes(user_id);

CREATE TABLE login_challenges (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  org_id      TEXT NOT NULL,
  ticket_hash TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  ip          TEXT NOT NULL DEFAULT '',
  ua          TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_challenges_ticket ON login_challenges(ticket_hash);
CREATE INDEX IF NOT EXISTS idx_login_challenges_user ON login_challenges(user_id);
