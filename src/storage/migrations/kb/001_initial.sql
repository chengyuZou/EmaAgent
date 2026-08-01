-- kb.db 当前开发基线。
-- 由压缩前完整迁移链生成最终 Schema 后规范化导出。
-- 后续结构变更从 002_*.sql 开始追加。
CREATE TABLE document_assets (
  id                TEXT    PRIMARY KEY,
  file_path         TEXT    NOT NULL,        -- 复制原件的路径(相对 {kb}/files)
  file_name         TEXT    NOT NULL,
  mime_type         TEXT    NOT NULL,
  title             TEXT,
  word_count        INTEGER NOT NULL DEFAULT 0,
  page_count        INTEGER,
  status            TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'indexing', 'indexed', 'error')),
  content_hash      TEXT,
  ebd_model         TEXT,                    -- 该文档被索引时使用的 embedding 模型
  ebd_dim           INTEGER,
  ebd_stale         INTEGER NOT NULL DEFAULT 0,
  use_count         INTEGER NOT NULL DEFAULT 0,
  last_activated_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
, ebd_provider_id TEXT, ebd_normalization TEXT, ebd_revision TEXT, ebd_space_id TEXT);

CREATE TABLE document_chunks (
  id                TEXT    PRIMARY KEY,
  asset_id          TEXT    NOT NULL REFERENCES document_assets(id) ON DELETE CASCADE,
  text              TEXT    NOT NULL,
  tokens            TEXT    NOT NULL DEFAULT '',   -- jieba 分词副本,喂给 FTS5
  markdown          TEXT,
  block_kinds_json  TEXT    NOT NULL DEFAULT '[]',
  token_count       INTEGER NOT NULL DEFAULT 0,
  page              INTEGER,
  section_path_json TEXT    NOT NULL DEFAULT '[]',
  prev_id           TEXT,
  next_id           TEXT,
  mom_id            TEXT,                          -- 父("mom")窗口 id(small-to-big)
  mom_text          TEXT,                          -- 每个子块携带的完整父窗口文本
  embedding         BLOB                           -- Float32 二进制:4 bytes × dim
, embedding_space_id TEXT);

CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  tokens,
  chunk_id  UNINDEXED,
  asset_id  UNINDEXED,
  tokenize  = 'unicode61 remove_diacritics 1'
);

CREATE TABLE document_previews (
  asset_id        TEXT    PRIMARY KEY REFERENCES document_assets(id) ON DELETE CASCADE,
  text            TEXT    NOT NULL DEFAULT '',
  thumbnail       BLOB,
  thumbnail_mime  TEXT,
  page_count      INTEGER,
  word_count      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE kb_ingest_failure_shards (
  task_id        TEXT NOT NULL REFERENCES kb_ingest_tasks(id) ON DELETE CASCADE,
  stage          TEXT NOT NULL CHECK (stage IN ('parse', 'embed')),
  shard_key      TEXT NOT NULL,
  item_ids_json  TEXT NOT NULL DEFAULT '[]',
  retryable      INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
  error_code     TEXT,
  error          TEXT NOT NULL,
  attempt        INTEGER NOT NULL CHECK (attempt >= 1),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (task_id, stage, shard_key)
);

CREATE TABLE kb_ingest_tasks (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT NOT NULL,
  file_path        TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  mime_type        TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'failed', 'partial_failed')),
  stage            TEXT,
  progress         REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  error_code       TEXT,
  error             TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  version          INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  lease_token      TEXT,
  lease_expires_at INTEGER,
  next_retry_at    INTEGER NOT NULL DEFAULT 0,
  total_items      INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  completed_items  INTEGER NOT NULL DEFAULT 0 CHECK (completed_items >= 0),
  failed_items     INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE kb_reembed_failure_shards (
  task_id       TEXT NOT NULL REFERENCES kb_reembed_tasks(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL CHECK (stage IN ('embed')),
  shard_key     TEXT NOT NULL,
  item_ids_json TEXT NOT NULL DEFAULT '[]',
  retryable     INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
  error_code    TEXT,
  error         TEXT NOT NULL,
  attempt       INTEGER NOT NULL CHECK (attempt >= 1),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (task_id, stage, shard_key)
);

CREATE TABLE kb_reembed_tasks (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT,
  ebd_provider_id  TEXT NOT NULL,
  ebd_model        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'failed', 'partial_failed', 'cancelled')),
  stage            TEXT,
  progress         REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  error_code       TEXT,
  error            TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  version          INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  lease_token      TEXT,
  lease_expires_at INTEGER,
  next_retry_at    INTEGER NOT NULL DEFAULT 0,
  total_items      INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  completed_items  INTEGER NOT NULL DEFAULT 0 CHECK (completed_items >= 0),
  failed_items     INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX idx_doc_assets_created
  ON document_assets(created_at DESC, id DESC);

CREATE INDEX idx_doc_assets_ebd_space
  ON document_assets(ebd_space_id, ebd_stale);

CREATE INDEX idx_doc_assets_ebd_stale ON document_assets(ebd_stale) WHERE ebd_stale = 1;

CREATE INDEX idx_doc_assets_hash      ON document_assets(content_hash);

CREATE INDEX idx_doc_assets_lastact   ON document_assets(last_activated_at);

CREATE INDEX idx_doc_assets_status    ON document_assets(status);

CREATE INDEX idx_doc_chunks_asset ON document_chunks(asset_id);

CREATE INDEX idx_doc_chunks_embedding_space
  ON document_chunks(embedding_space_id)
  WHERE embedding IS NOT NULL;

CREATE INDEX idx_doc_chunks_mom   ON document_chunks(mom_id);

CREATE UNIQUE INDEX idx_kb_ingest_asset
  ON kb_ingest_tasks(asset_id);

CREATE INDEX idx_kb_ingest_lease
  ON kb_ingest_tasks(status, lease_expires_at, id);

CREATE INDEX idx_kb_ingest_ready
  ON kb_ingest_tasks(status, next_retry_at, created_at, id);

CREATE INDEX idx_kb_reembed_lease
  ON kb_reembed_tasks(status, lease_expires_at, id);

CREATE INDEX idx_kb_reembed_ready
  ON kb_reembed_tasks(status, next_retry_at, created_at, id);

CREATE TRIGGER doc_chunks_fts_ad
AFTER DELETE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER doc_chunks_fts_ai
AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(rowid, tokens, chunk_id, asset_id)
  VALUES (NEW.rowid, NEW.tokens, NEW.id, NEW.asset_id);
END;

CREATE TRIGGER doc_chunks_fts_au
AFTER UPDATE OF tokens ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE rowid = OLD.rowid;
  INSERT INTO document_chunks_fts(rowid, tokens, chunk_id, asset_id)
  VALUES (NEW.rowid, NEW.tokens, NEW.id, NEW.asset_id);
END;
