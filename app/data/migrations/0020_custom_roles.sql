-- ---------------------------------------------------------------------------
-- 0020 · 自定义角色授权（0.20.0）
--
-- 背景：角色绑定链路（roles / role_bindings / roleKeysForUser）从一开始就按
-- 「roles 表行」通用设计 —— 判定层不认"内置与否"，只认 key。真正的缺口在
-- 授权语义：permissions.mjs 的 ROLE_MATRIX 硬编码 4 个内置角色，
-- 自定义角色需要一个**按行存放授权**的表，判定层按 (resource, action) 并集。
--
-- 设计：
--   · 一行 = 一个 (角色, 资源, 动作) 授予。逐行而不是 grants JSON  blob：
--     断言唯一（主键）、按角色索引、逐条审计/回显都直接。
--   · 与 roles 同生共死：仓储层删除角色时**显式**先删本表行（不用
--     ON DELETE CASCADE —— 与全库纪律一致：外键默认 RESTRICT，
--     删除步骤固定、可数、可在事务里与"还有没有人绑定"的护栏一起回滚）。
--   · 授权白名单不在库里：可授予什么由 permissions.mjs 的
--     CUSTOM_GRANTABLE 纯函数把守（不给任何 delete、治理面写权不下放），
--     写库前必过校验 —— 库里出现白名单外的行只有一种可能：有人绕过
--     服务层直接写库，那已超出本平台的威胁模型（能写库的人什么都能做）。
--
-- 只增不改（迁移纪律）：新增迁移，不动历史迁移。
--
-- Copyright 2026 liwei（易智瑞西安）.
-- ---------------------------------------------------------------------------

CREATE TABLE role_grants (
  role_id  TEXT NOT NULL REFERENCES roles(id),
  resource TEXT NOT NULL,
  action   TEXT NOT NULL,
  PRIMARY KEY (role_id, resource, action)
);

CREATE INDEX IF NOT EXISTS idx_role_grants_role ON role_grants(role_id);
