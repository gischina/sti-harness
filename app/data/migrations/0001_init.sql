-- 0001_init.sql — 基础表结构（身份 / 会话 / 知识 / 治理 / 能力）
--
-- 纪律：
--   · 只走增量迁移，不改本文件（migrate.mjs 会校验校验和）
--   · 所有业务表带 tenant_id，仓储层强制注入过滤（逻辑隔离）
--   · 时间统一用 ISO8601 文本（可排序、便于跨驱动迁移）
--   · 中文全文检索**不得裸用 unicode61**：chunks 预存 bigrams 列，见文件末尾 FTS5 段
--
-- Copyright 2026 liwei（易智瑞西安）.

-- ---------------------------------------------------------------------------
-- 1. 身份与权限
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  parent_id   TEXT REFERENCES orgs(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES departments(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(org_id);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  dept_id       TEXT REFERENCES departments(id),
  username      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  pwd_hash      TEXT NOT NULL DEFAULT '',
  pwd_salt      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE (org_id, username)
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  org_id      TEXT REFERENCES orgs(id),           -- NULL = 内置全局角色
  key         TEXT NOT NULL,                      -- owner | admin | member | viewer
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, key)
);

CREATE TABLE IF NOT EXISTS role_bindings (
  id           TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,                     -- user | group
  subject_id   TEXT NOT NULL,
  role_id      TEXT NOT NULL REFERENCES roles(id),
  scope_type   TEXT NOT NULL DEFAULT 'tenant',    -- tenant | org | knowledge_base | ...
  scope_id     TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_role_bindings_subject ON role_bindings(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,               -- 只存哈希，绝不存明文令牌
  expires_at  TEXT NOT NULL,
  ip          TEXT NOT NULL DEFAULT '',
  ua          TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT '',          -- 逗号分隔
  expires_at   TEXT,
  last_used_at TEXT,
  created_at   TEXT NOT NULL
);

-- 凭据：只存密文。cipher = AES-256-GCM 的 iv‖tag‖ciphertext（base64）
CREATE TABLE IF NOT EXISTS credentials (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  name        TEXT NOT NULL,
  provider    TEXT NOT NULL DEFAULT '',
  cipher      TEXT NOT NULL,
  ref_count   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  UNIQUE (org_id, name)
);

-- ---------------------------------------------------------------------------
-- 2. 会话与事件
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  owner_user_id     TEXT,
  kernel            TEXT NOT NULL DEFAULT 'dsh',   -- dsh | mock
  kernel_session_id TEXT,                          -- 上游会话 id（provider 负责映射）
  title             TEXT NOT NULL DEFAULT '',
  cwd               TEXT NOT NULL DEFAULT '',
  preset_id         TEXT,
  model_provider    TEXT NOT NULL DEFAULT '',
  model_id          TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  archived_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON agent_sessions(tenant_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES agent_sessions(id),
  turn_id      TEXT,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,                      -- user | assistant | system | tool
  content_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

-- events 是**轨迹 / 交付物 / 工作流 / 统计的唯一数据源**。
-- 高频写点：写入必须走写合并（批量事务），不得逐条 run()。见 architecture.md §7.4。
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES agent_sessions(id),
  turn_id      TEXT,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,                      -- KernelEvent.type
  role         TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',         -- 语义字段（input_tokens 等），非上游原名
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

CREATE TABLE IF NOT EXISTS usage_records (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT,
  session_id  TEXT,
  turn_id     TEXT,
  input       INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  ttft_ms     INTEGER,
  tps         REAL,
  model_id    TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_time ON usage_records(tenant_id, created_at);

-- ---------------------------------------------------------------------------
-- 3. 知识库（混合检索）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  name               TEXT NOT NULL,
  embedding_provider TEXT NOT NULL DEFAULT '',     -- openai-compat | ollama | '' (无 → 纯文本检索)
  embedding_model    TEXT NOT NULL DEFAULT '',
  dim                INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_tenant ON knowledge_bases(tenant_id);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  kb_id        TEXT NOT NULL REFERENCES knowledge_bases(id),
  title        TEXT NOT NULL DEFAULT '',
  mime         TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL DEFAULT 0,
  sha256       TEXT NOT NULL DEFAULT '',
  storage_path TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending|parsing|ready|failed
  error        TEXT,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  parsed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_kb ON documents(kb_id, status);

-- body  = 原文（英文/数字走 unicode61 原生分词）
-- bigrams = 中文重叠双字串（写入侧切好），中文检索的**唯一可行路径**
CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES documents(id),
  kb_id       TEXT NOT NULL REFERENCES knowledge_bases(id),
  ord         INTEGER NOT NULL,
  body        TEXT NOT NULL,
  bigrams     TEXT NOT NULL DEFAULT '',
  meta_json   TEXT NOT NULL DEFAULT '{}',
  token_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id, ord);
CREATE INDEX IF NOT EXISTS idx_chunks_kb ON chunks(kb_id);

CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id),
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL                            -- Float32Array 直接落 BLOB
);

-- ---------------------------------------------------------------------------
-- 4. 治理与能力
-- ---------------------------------------------------------------------------

-- 审计哈希链：hash = SHA256(prev_hash ‖ tenant_id ‖ user_id ‖ action ‖ resource ‖ result ‖ detail ‖ at)
-- prev_hash 取同租户上一条；校验接口可从头重算，定位首个断裂点。
CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  user_id       TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id   TEXT NOT NULL DEFAULT '',
  result        TEXT NOT NULL,                      -- ok | denied | error
  detail_json   TEXT NOT NULL DEFAULT '{}',
  prev_hash     TEXT NOT NULL DEFAULT '',
  hash          TEXT NOT NULL,
  at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_logs(tenant_id, at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, at);

CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  turn_id     TEXT,
  tool_name   TEXT NOT NULL,
  args_json   TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected | expired
  decided_by  TEXT,
  decided_at  TEXT,
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);

CREATE TABLE IF NOT EXISTS quotas (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  subject_type TEXT NOT NULL,                       -- tenant | user | role
  subject_id   TEXT NOT NULL,
  metric       TEXT NOT NULL,                       -- input_tokens | output_tokens | turns | concurrent
  limit_value  REAL NOT NULL,
  period       TEXT NOT NULL DEFAULT 'month',       -- day | month | total
  enabled      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, subject_type, subject_id, metric, period)
);

CREATE TABLE IF NOT EXISTS skills (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  name             TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'local',   -- local | market | zip
  version          TEXT NOT NULL DEFAULT '',
  path             TEXT NOT NULL DEFAULT '',
  enabled          INTEGER NOT NULL DEFAULT 1,
  model_invocable  INTEGER NOT NULL DEFAULT 1,
  installed_at     TEXT NOT NULL,
  meta_json        TEXT NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS tools (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  origin      TEXT NOT NULL DEFAULT '',             -- builtin | mcp | skill
  enabled     INTEGER NOT NULL DEFAULT 1,
  policy_json TEXT NOT NULL DEFAULT '{}',
  meta_json   TEXT NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  transport     TEXT NOT NULL DEFAULT 'stdio',      -- stdio | sse | http
  config_cipher TEXT NOT NULL DEFAULT '',           -- 连接配置（可能含密钥）加密存储
  enabled       INTEGER NOT NULL DEFAULT 1,
  health        TEXT NOT NULL DEFAULT 'unknown',    -- unknown | ok | error
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS capability_bindings (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  subject_type    TEXT NOT NULL,                    -- tenant | user | role
  subject_id      TEXT NOT NULL,
  capability_type TEXT NOT NULL,                    -- connection | server | tool | skill
  capability_id   TEXT NOT NULL,
  allow           INTEGER NOT NULL DEFAULT 1        -- 三级治理：连接 / 服务 / 工具
);
CREATE INDEX IF NOT EXISTS idx_cap_bindings_subject ON capability_bindings(tenant_id, subject_type, subject_id);

-- ---------------------------------------------------------------------------
-- 5. 全文检索（FTS5）
--
--   ⚠️ 中文检索的关键：**不能裸用 unicode61**。
--   实测（SQLite 3.50.4）：unicode61 把一整段连续汉字当成「一个 token」，
--   于是 `MATCH '权限管理'` / `MATCH '权限'` 全部 0 命中，只有整句或前缀命中。
--   trigram（3.34+）虽可用，但对 **2 字词**（「权限」「管理」）召回为 0。
--   因此：写入侧把中文切成重叠双字串存入 chunks.bigrams，检索侧做同样切分。
--   详见 docs/feasibility.md §1.2.1。
-- ---------------------------------------------------------------------------

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  body,
  bigrams,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_fts(rowid, body, bigrams) VALUES (new.id, new.body, new.bigrams);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, body, bigrams) VALUES ('delete', old.id, old.body, old.bigrams);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, body, bigrams) VALUES ('delete', old.id, old.body, old.bigrams);
  INSERT INTO chunk_fts(rowid, body, bigrams) VALUES (new.id, new.body, new.bigrams);
END;
