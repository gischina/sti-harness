-- ---------------------------------------------------------------------------
-- 0012 · 会话附件（工作台最后一公里：3.6）
--
-- 为什么需要：
--   工作台此前只能"打字提问"，用户手里已有的材料（一份需求文档、一段日志、
--   一个 CSV）没有任何入口。企业场景里"带着材料问"比"空手问"是常态。
--
-- 为什么单独一张表、而不是塞进 events 的 payload：
--   ① 附件是**对象**（有名字、大小、哈希、落盘路径），不是一次性的语义事件；
--     塞进 payload 就只能靠"从事件流里捞最后一条"来查，改一次名字要改历史；
--   ② 删除附件必须能真的删（合规上"删除请求"要能落到字节上），
--     而事件是 append-only 的轨迹 —— 两者生命周期根本不同，不该同表。
--
-- 三个必须写死在这里的语义（否则一年后没人说得清）：
--   · `stored_path` 存的是**相对 STORAGE_DIR 的路径**，不是绝对路径 ——
--     绝对路径会把部署机的目录结构泄漏到 API 响应里（换机器就全成死链）。
--   · `kind` 只有两个取值：`text`（能以 UTF-8 解码、无 NUL 字节）与 `binary`。
--     这个判定在**服务层**做，并决定"能不能注入本轮上下文" —— 见 kernel.mjs。
--   · `tenant_id` 是**冗余**的（可经 session_id 推出），但必须存：
--     附件是按 id 直接寻址的资源，每一次读写都要能一句话证明"它属于这个租户"，
--     不允许任何一条语句依赖"先 JOIN 会话再判断"这种间接推理。
--
-- 只增不改（迁移纪律）：新表，不动任何历史定义。
--
-- Copyright 2026 liwei（易智瑞西安）.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS session_attachments (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL REFERENCES agent_sessions(id),
  user_id     TEXT,
  name        TEXT NOT NULL,                     -- 已消毒的原始文件名（去目录成分、限制字符集）
  mime        TEXT NOT NULL DEFAULT '',
  bytes       INTEGER NOT NULL,                  -- 实际落盘字节数（不是声明值 —— 以真实写入为准）
  kind        TEXT NOT NULL,                     -- 'text' | 'binary'
  stored_path TEXT NOT NULL,                     -- 相对 STORAGE_DIR；不存绝对路径
  sha256      TEXT NOT NULL DEFAULT '',          -- 内容指纹：重复上传可辨认，也便于事后核对
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attach_session ON session_attachments(tenant_id, session_id, created_at);
