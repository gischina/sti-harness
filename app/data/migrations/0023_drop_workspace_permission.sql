-- ---------------------------------------------------------------------------
-- 0023 · 删掉工作区的权限模块（visibility 列 + workspace 级授权绑定）
--
-- 删什么：
--   1. `workspaces.visibility`（open / restricted）；
--   2. `role_bindings` 里 `scope_type = 'workspace'` 的全部绑定（工作区级授权名单）。
--
-- 为什么删（用户裁定，2026-10-06）：
--   **上游 dsh 自己有一份工作区权限三档**。平台这份是第二份真相，而平台**没有任何
--   接口去改上游那一份** —— 两边永远对不上：在这里把人调成"完全权限"，上游那侧
--   一动不动。**一份改了不生效的权限配置比没有权限配置更糟**：它让人以为已经管住了。
--   于是整块删除（界面 / 接口 / 名单 / 可见性一起），等想清楚怎么与上游对齐再回来做。
--
-- 删完之后谁在把门：
--   · 档位改由**组织角色**推导（platform/workspace/visibility.mjs 的 levelFromRoles
--     本来就是这个逻辑，只是从前还要把 scoped 绑定并进来。见 0021 头注释第 3 条 ——
--     "档位是派生值，存进本表会造出第二真相"，那条纪律现在推到了它的结论）；
--   · 路由层仍由 `session:read` / `session:write` / `session:execute` 把守。
--   **门禁没有消失，消失的是"这个工作区单独授权"这一层。**
--
-- 数据影响说清（**不可逆**）：
--   · 被删的 workspace 级绑定无法恢复（迁移不做备份）；
--   · 原本 `restricted` 的工作区会**对所有成员可见** —— 这正是"可见性一并删掉"的裁定；
--   · 工作区与会话**本体一行不动**，只有权限数据没了。
--
-- 只增不改（迁移纪律）：0021 里那句 `visibility TEXT NOT NULL DEFAULT 'open'`
-- 一个字都不能动 —— migrate.mjs 对已应用迁移做 sha256 比对，改了会硬失败。
--
-- Copyright 2026 liwei（易智瑞西安）.
-- ---------------------------------------------------------------------------

ALTER TABLE workspaces DROP COLUMN visibility;

-- 工作区级授权绑定。库级（knowledge_base）与租户级的绑定**不动** ——
-- 知识库 ACL 与平台 RBAC 都还在用它们（见 platform/knowledge/service.mjs）。
DELETE FROM role_bindings WHERE scope_type = 'workspace';
