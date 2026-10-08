-- ---------------------------------------------------------------------------
-- 0021 · 工作区（对话工作台的树状组织层）
--
-- 为什么加这张表：
--   0.20.1 及以前，会话是一张**平铺列表**（`agent_sessions` 按 updated_at 排序）。
--   会话一多，"这批会话属于哪个项目"只能靠标题猜。原生 DeepSeek Harness 的第一屏
--   已经给了答案：左侧是「工作区」树 —— 工作区节点下挂会话，外加一个"未分组"桶。
--   上游内核**没有**工作区清单 RPC（compat 实测只有 workspace/archiveSession），
--   所以工作区是**平台侧**的组织概念：归属、命名、授权全部落在本地库，
--   上游只继续认它本来就认的两样东西 —— cwd 与 sessionId。
--
-- 三条边界（改这张表时请一起读）：
--   1. **工作区 ≠ 上游实体**：不向上游同步任何工作区信息。新建会话时把工作区的
--      cwd 作为会话 cwd 传上去（决定上游项目级能力的作用范围），仅此而已。
--   2. **不建外键**：与 kb_ids 同一条纪律 —— 删工作区不该被"有会话挂着"挡住。
--      删除工作区时会话**原地保留**，workspace_id 置空（落回"未分组"），不级联删会话。
--   3. **权限三档落在授权表，不落这张表**：workspace 行只有 visibility
--      （open / restricted，与知识库 0013 同构）；"仅可查看 / 工作区内修改 /
--      完全权限"三档是 role_bindings（scope_type='workspace'）上的**派生值**
--      （见 platform/workspace/visibility.mjs）。档位存进本表会造出第二真相。
--
-- agent_sessions 的两个新列：
--   · workspace_id —— 会话挂在哪个工作区（NULL = 未分组，行为与 0.20.1 逐字不变）。
--   · reasoning_effort —— 会话当前的推理等级（模型目录 reasoning.efforts 里的 id，
--     如 off/low/high/max）。此前 selectModel 只把它透传上游、本地不记，
--     内核重启后"这个会话用的什么推理等级"就丢了；成本口径不受影响（它不是 token 列）。
--
-- 只增不改（迁移纪律）：这是新增迁移，不动既有列。
--
-- Copyright 2026 liwei（易智瑞西安）.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  owner_user_id TEXT,
  name          TEXT NOT NULL,
  cwd           TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  -- open = 全租户可见（档位按全局角色推导，member 默认即"工作区内修改"）；
  -- restricted = 仅授权主体可见（role_bindings scope_type='workspace'，防自锁同 0013）
  visibility    TEXT NOT NULL DEFAULT 'open',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_workspaces_tenant ON workspaces(tenant_id, updated_at);

ALTER TABLE agent_sessions ADD COLUMN workspace_id TEXT;
ALTER TABLE agent_sessions ADD COLUMN reasoning_effort TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON agent_sessions(tenant_id, workspace_id);
