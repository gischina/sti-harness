-- ---------------------------------------------------------------------------
-- 0007 · 用户组（P0-D 遗留缺陷 #8）
--
-- 为什么需要（这是**一处静默空转**，不是"为了整齐"）：
--   0001 建 `role_bindings` 时把 `subject_type` 注释成 `-- user | group`，
--   但**从来没有 groups 表**，判定路径也只看 `subject_type='user'`。
--   后果：调用方按注释写 `subjectType:'group'` 绑定一个组 id，会拿到
--   `{ok:true}` 并真的写进库 —— 然而权限判定永远读不到它。
--   调用方以为授权成功了，实际什么都没发生，且没有任何报错。
--   「承认一种主体类型却无法表达它」比直接不支持更危险。
--
-- 本迁移 **只增不改**（不动 0001 的历史定义，符合迁移纪律）：
--   · `groups`        组织内的组（权限载体，与部门并列但用途不同）
--   · `group_members` 组 ↔ 用户的成员关系（多对多）
--
-- 隔离说明（诚实边界）：
--   本表族沿用身份模块的 `org_id` 命名（users / roles / credentials 同），
--   而不是 `tenant_id` —— 因此 `tools/audit-tenant-isolation.mjs` 的静态扫描
--   （按「是否有 tenant_id 列」推导清单）**不覆盖**这两张表。
--   补偿手段是更强的一层：`test-governance` 的跨租户动态用例逐条钉住
--   「组取不到别家的、成员加不进别家的、绑定借不到别家的角色」。
--   静态扫描抓「忘了写过滤」，动态用例抓「过滤值用错」—— 两层合起来才算数。
--
-- Copyright 2026 liwei（易智瑞西安）.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_groups_org ON groups(org_id);

CREATE TABLE IF NOT EXISTS group_members (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
