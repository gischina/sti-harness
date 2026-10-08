-- ---------------------------------------------------------------------------
-- 0013 · 知识库级访问控制（4.6）
--
-- 为什么需要：
--   此前知识库的隔离只到**租户级** —— 同一个组织内，任何有 `knowledge:read`
--   的成员都能看到、检索到全部知识库。企业里这不是"够用"，而是"不能用"：
--   财务的制度库、法务的合同库、HR 的薪酬库，天然不该给研发同事看见。
--   本迁移补的正是这一层：**租户内按库授权**。
--
-- 为什么是一个显式字段，而不是"用有无授权推断"：
--   一种更省事的设计是「该库存在任意一条授权 = 该库受限；没有授权 = 全租户可见」。
--   但它把"库的可见性模式"变成**隐式状态**：删掉最后一条授权时，库会**悄悄**
--   从"受限"变回"全租户可见"—— 一次看似只影响一个用户的撤权，会静默地把库
--   开放给所有人。这种"配置与行为对不上"是最难查的一类问题，所以宁可用一个
--   可查询、可审计的显式字段。
--
-- 为什么默认值必须是 'tenant'：
--   `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT 'tenant'` 会让**所有现存库**
--   落在 `tenant` 上，于是升级后行为与升级前**逐字一致**。若默认 'restricted'，
--   一次升级就会让全组织突然看不见任何知识库 —— 那是灾难，不是安全。
--
-- 为什么不在列上加 CHECK 约束：
--   与 0011 同一理由 —— 值域由服务层校验（`knowledge/service.mjs` 的
--   `normalizeVisibility`），坏值在写入前就被拒，且错误信息能说清"收到什么、
--   允许什么"。SQLite 的 ALTER ADD COLUMN 加 CHECK 在跨版本上行为不一致。
--
-- 授权载体复用 `role_bindings` 的**既有预留**（0001 就写了
-- `scope_type ... -- tenant | org | knowledge_base | ...`，并带 `scope_id`）：
--   库级授权 = `scope_type='knowledge_base'`, `scope_id=<kb_id>` 的绑定行。
--   **零新表** —— 这也是 0001 那条注释原本就规划好的位置。
--
-- 只增不改（迁移纪律）：只 ADD COLUMN，不动任何历史定义、不改任何历史行。
--
-- Copyright 2026 liwei（易智瑞西安）.
-- ---------------------------------------------------------------------------

ALTER TABLE knowledge_bases ADD COLUMN visibility TEXT NOT NULL DEFAULT 'tenant';

-- 只为"列出本租户的受限库"这类查询服务；存量行全是 'tenant'，索引很小。
CREATE INDEX IF NOT EXISTS idx_kb_visibility ON knowledge_bases(tenant_id, visibility);

-- 说明：本迁移**不**为 `role_bindings` 建新索引。库级绑定与租户级绑定同表，
-- 查询走既有的 `idx_role_bindings_subject(subject_type, subject_id)`（按主体取
-- 该用户的全部绑定，再在内存里筛 scope）—— 单组织绑定数量是百量级，
-- 新加一个 `(scope_type, scope_id)` 索引收益有限、却多一份维护面，故不加。
