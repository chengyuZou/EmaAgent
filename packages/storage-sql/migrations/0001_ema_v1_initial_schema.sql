-- EmaAgent V1 初始 SQLite schema。
-- 这份 SQL 与 src/schema.ts / src/migrations.ts 保持同构；后续接入 drizzle-kit 后，
-- 可以把它作为第一版迁移基线。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode_last TEXT NOT NULL DEFAULT 'chat',
  title_status TEXT NOT NULL DEFAULT 'default',
  title_updated_at INTEGER,
  full_access INTEGER NOT NULL DEFAULT 0,
  active_skills_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_blocks_json TEXT NOT NULL DEFAULT '[]',
  tool_call_id TEXT,
  tool_calls_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, content);

CREATE TABLE IF NOT EXISTS turns (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  model_id TEXT,
  provider_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  usage_json TEXT,
  cost_usd REAL
);

CREATE INDEX IF NOT EXISTS idx_turns_session_started ON turns(session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES turns(request_id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  detail_json TEXT,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_steps_request ON steps(request_id);

CREATE TABLE IF NOT EXISTS stream_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES turns(request_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_events_request_seq ON stream_events(request_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES turns(request_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  mime TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  target_path TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  diff_base_hash TEXT,
  diff_head_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_request ON artifacts(request_id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);

CREATE TABLE IF NOT EXISTS attachment_chunks (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding_ref TEXT,
  token_count INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_chunks_order ON attachment_chunks(attachment_id, chunk_index);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  summary TEXT,
  salience REAL NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  embedding_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_items_lookup ON memory_items(namespace, kind, salience DESC);

CREATE TABLE IF NOT EXISTS provider_configs (
  provider_id TEXT PRIMARY KEY,
  base_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  secret_handle TEXT,
  custom_headers_yaml TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_bindings (
  role TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'fixed',
  fallback_chain_yaml TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS permission_grants (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_permission_grants_session ON permission_grants(session_id, tool_id);
