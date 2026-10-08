-- ---------------------------------------------------------------------------
-- 0008 · 模型中心（P1-1）
--
-- 为什么需要：
--   在 P1-1 之前，本平台的模型配置**只有一个来源**：`data/config.json` 的
--   `embedding*` 几个字段（进程级、单份、改完要重启），而**对话模型完全不可配**
--   （只能透传上游）。于是"平台侧模型治理"这件事在代码里没有落点 ——
--   运维想问"这台机器配了哪几个模型、哪个是默认、上游挂的那条链通不通"，
--   没有任何接口能回答。
--
-- 本迁移建立**模型注册表**：把"配了哪些模型服务"变成可查询、可探活、
-- 可排序（降级链）的数据，而不是散在配置文件与文档里的口头约定。
--
-- 隔离说明：
--   本表带 `tenant_id`，因此 `tools/audit-tenant-isolation.mjs` 的静态扫描
--   **会**覆盖它（按「迁移里是否有 tenant_id 列」推导清单）。
--   这与 0007 的 groups 表（用 org_id、靠动态用例兜底）不同 ——
--   模型配置本来就是按组织隔离的，用 tenant_id 才是正确的命名。
--
-- 只增不改（迁移纪律）：
--   · `model_providers` 一张表即可表达"注册表 + 默认 + 降级链"：
--     降级链不是另一张表，而是**同 kind 下按 priority 排序的启用项序列** ——
--     多一张链表就要维护"链与项一致"这个新的一致性负担，而它能表达的
--     信息（顺序）在 priority 一列里已经完整。
--   · `is_default` 用**部分唯一索引**在库层保证「每个租户每种 kind 至多一个默认」，
--     而不是只在服务层判 —— 服务层判漏一条路径，库层不会漏。
--
-- Copyright 2026 liwei（易智瑞西安）.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_providers (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  -- 人类可读标识，租户内唯一（用于接口里一眼认出"是哪一台"）
  name            TEXT NOT NULL,
  -- 用途：chat = 对话模型；embedding = 向量模型。两者配置形状相近但探活方式不同。
  kind            TEXT NOT NULL,
  -- 线协议。chat 用 anthropic-messages / openai-compat；
  -- embedding 用 openai-compat / ollama。'none' 只对 embedding 有意义（显式不配向量）。
  protocol        TEXT NOT NULL,
  base_url        TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  -- 指向 credentials 表的**名称**，不是值。值经 AES-256-GCM 加密存放，
  -- 接口与日志永远不回显它（这是本表不存密钥的原因）。
  credential_name TEXT NOT NULL DEFAULT '',
  -- 降级链序号：同 kind 内数值小的先用。默认 100，留出前后插入空间。
  priority        INTEGER NOT NULL DEFAULT 100,
  enabled         INTEGER NOT NULL DEFAULT 1,
  is_default      INTEGER NOT NULL DEFAULT 0,
  label           TEXT NOT NULL DEFAULT '',
  meta_json       TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_model_providers_tenant ON model_providers(tenant_id, kind, priority);

-- 「每个租户每种 kind 至多一个默认」由库层保证。若服务层漏清旧默认，
-- 这里会直接拒绝写入，而不是留下两个默认让 resolveDefault 的结果取决于行序。
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_providers_default
  ON model_providers(tenant_id, kind) WHERE is_default = 1;
