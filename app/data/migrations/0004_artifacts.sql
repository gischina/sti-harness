-- 0004 · 产物留存（M3 顺延项，0.5.0 开头补做）。
--
-- 「变更类工具产出的文件路径提取」的落点：平台侧工具执行（tools.execute）与
-- 回合内 tool 事件的 args / result 里出现的文件系统路径，被提取后记在这里 ——
-- 目的不是替上游记账，而是让「这个会话动过哪些文件」可查询、可随会话日志一起导出。
--
-- 只增不改：本迁移只建新表，不动历史迁移。

CREATE TABLE IF NOT EXISTS tool_artifacts (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  turn_id     TEXT,
  tool_name   TEXT NOT NULL,
  path        TEXT NOT NULL,
  direction   TEXT NOT NULL DEFAULT 'output',   -- input（工具的参数里出现）| output（工具的结果里出现）
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_artifacts_session ON tool_artifacts(tenant_id, session_id, recorded_at);
