-- ---------------------------------------------------------------------------
-- 0002 · documents 增加「来源」信息
--
-- 为什么需要：M2 支持多种导入方式（上传文件 / 粘贴文本 / 后续的目录与 URL）。
-- 「这份内容从哪来」在治理上是必要的 —— 出问题时第一个要问的就是它，
-- 而且不同来源的**可信度不同**（外部抓取的网页 vs 内部制度文件）。
--
-- 纪律：这里是**新增**迁移，不改 0001。0001 已经应用过的机器会按版本号顺序补上。
-- ---------------------------------------------------------------------------

ALTER TABLE documents ADD COLUMN source_type TEXT NOT NULL DEFAULT '';  -- file | text | url | directory
ALTER TABLE documents ADD COLUMN source_ref  TEXT NOT NULL DEFAULT '';  -- 原始文件名 / URL（不含绝对路径，避免泄漏部署机目录结构）

CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(kb_id, source_type);
