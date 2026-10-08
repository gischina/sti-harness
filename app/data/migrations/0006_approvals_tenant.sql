-- ---------------------------------------------------------------------------
-- 0006 · 审批单补 tenant_id（M5 多租户隔离审计发现的缝隙 · P0-D）
--
-- 为什么需要（这是一个**真实的越权缝隙**，不是"为了整齐"）：
--   0001 建 approvals 表时**没有 tenant_id**。于是：
--     1. 审批门 `checkGate()` 找"已批准单"的查询里，tool_name + args + status 都匹配、
--        但**没有租户条件** —— 租户 A 批准过「工具 T + 参数 X」，租户 B 用自己的身份
--        调同一个 T + X，会直接命中 A 的那张单而被放行（还会把 A 的单消费掉）。
--        两个租户只要用了同一个工具、同一组参数，就互相"借用"审批。
--     2. `decide()` 只按 id 更新状态，不校验租户 —— 租户 B 的管理员只要拿到/猜到
--        租户 A 的审批单 id，就能批准它。
--   这是隔离纪律里最不能容忍的一类：**越权是静默的**，没有报错、没有日志。
--
-- 本迁移 **只增不改**（不动 0001 的历史定义，符合迁移纪律）：
--   · 加 tenant_id 列，默认 ''（空串是明确的"未知归属"哨兵，不是 NULL）；
--   · 把历史行里**能判定**的（带 session 的）从 agent_sessions 回填；
--   · 回填不到的旧行保持 '' —— 查询按 tenant_id 严格相等过滤，于是它们**对所有人隐藏**
--     （fail-closed：宁可让一条历史审批单在 UI 里看不到，也不能让它跨租户生效）。
--     新写入的审批单一律带 tenant_id（create() 现在是硬要求），不会再产生 '' 行。
--
-- Copyright 2026 liwei（易智瑞西安）.
-- ---------------------------------------------------------------------------

ALTER TABLE approvals ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';

-- 回填：带 session 的历史单，从会话继承租户；会话已不在的保持 ''（无法判定就不猜）。
UPDATE approvals
   SET tenant_id = (SELECT s.tenant_id FROM agent_sessions s WHERE s.id = approvals.session_id)
 WHERE session_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = approvals.session_id);

-- 审批门的查询形态：按租户 + 状态取最新单。索引跟着查询走。
CREATE INDEX IF NOT EXISTS idx_approvals_tenant ON approvals(tenant_id, status, created_at);
