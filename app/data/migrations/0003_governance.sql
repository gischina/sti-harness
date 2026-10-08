-- ---------------------------------------------------------------------------
-- 0003 · 治理与审计（M3）：配额模式列 + 工具审批策略表
--
-- 为什么需要：
--   1. quotas 加 mode：配额超限时有「硬拦截（block）」与「提醒（warn）」两种治理姿态，
--      这本身就是治理决策，必须以数据形式存在（可导出、可 diff），不能写成硬编码。
--   2. tool_policies：审批门的策略来源。哪些工具执行前需要人工审批，
--      是管理员显式声明的治理规则 —— 默认（表里没有）= 放行，
--      这样"加一条策略"与"删一条策略"都是显式动作，不会出现隐式拦截。
--
-- 纪律：这里是**新增**迁移，不改 0001/0002。已应用过的机器按版本号顺序补上。
-- ---------------------------------------------------------------------------

ALTER TABLE quotas ADD COLUMN mode TEXT NOT NULL DEFAULT 'block';  -- block=超限拦截 | warn=超限提醒但放行

-- 敏感工具审批策略。
--   policy = 'allow'    直接放行（不建审批单）
--   policy = 'approval' 执行前必须有已批准的审批单（tool_name + args 哈希匹配，单次有效）
-- 不在表里的工具 = 默认放行。策略是显式声明的，隐式拦截会让使用者困惑。
CREATE TABLE IF NOT EXISTS tool_policies (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  tool_name  TEXT NOT NULL,
  policy     TEXT NOT NULL DEFAULT 'allow',       -- allow | approval
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, tool_name)
);
CREATE INDEX IF NOT EXISTS idx_tool_policies_tenant ON tool_policies(tenant_id, tool_name);
