-- kb.db 当前开发基线。任务表采用单进程执行语义，不保留租约、CAS 或局部失败分片。
CREATE TABLE document_assets (
  id                TEXT PRIMARY KEY,
  file_path         TEXT NOT NULL,
  file_name         TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  title             TEXT,
  word_count        INTEGER NOT NULL DEFAULT 0,
  page_count        INTEGER,
  status            TEXT NOT NULL
                    CHECK (status IN ('indexing', 'ready', 'failed')),
  content_hash      TEXT,
  embedding_provider_id TEXT,
  embedding_model   TEXT,
  embedding_dim     INTEGER,
  embedding_space_id TEXT,
  embedding_stale   INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE document_chunks (
  id                 TEXT PRIMARY KEY,
  asset_id           TEXT NOT NULL REFERENCES document_assets(id) ON DELETE CASCADE,
  text               TEXT NOT NULL,
  tokens             TEXT NOT NULL DEFAULT '',
  markdown           TEXT,
  block_kinds_json   TEXT NOT NULL DEFAULT '[]',
  token_count        INTEGER NOT NULL DEFAULT 0,
  page               INTEGER,
  section_path_json  TEXT NOT NULL DEFAULT '[]',
  parent_id          TEXT,
  parent_text        TEXT,
  embedding          BLOB,
  embedding_space_id TEXT
);

CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  tokens,
  chunk_id UNINDEXED,
  asset_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 1'
);

CREATE TABLE document_previews (
  asset_id       TEXT PRIMARY KEY REFERENCES document_assets(id) ON DELETE CASCADE,
  text           TEXT NOT NULL DEFAULT '',
  thumbnail      BLOB,
  thumbnail_mime TEXT,
  page_count     INTEGER,
  word_count     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE kb_ingest_tasks (
  id         TEXT PRIMARY KEY,
  asset_id   TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  file_name  TEXT NOT NULL,
  mime_type  TEXT,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  stage      TEXT,
  progress   REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- kb_reembed_tasks 一行一个资产：整库重建由上层 fan-out 成 N 行，逐行可查可重试。
CREATE TABLE kb_reembed_tasks (
  id              TEXT PRIMARY KEY,
  asset_id        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  stage           TEXT,
  progress        REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_doc_assets_created ON document_assets(created_at DESC, id DESC);
CREATE INDEX idx_doc_assets_embedding_space ON document_assets(embedding_space_id, embedding_stale);
CREATE INDEX idx_doc_assets_embedding_stale ON document_assets(embedding_stale) WHERE embedding_stale = 1;
-- 内容哈希唯一：并发导入同内容文件时第二个写入方吃约束冲突，不静默双份入库。
CREATE UNIQUE INDEX idx_doc_assets_hash ON document_assets(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX idx_doc_assets_status ON document_assets(status);
CREATE INDEX idx_doc_chunks_asset ON document_chunks(asset_id);
CREATE INDEX idx_doc_chunks_embedding_space
  ON document_chunks(embedding_space_id) WHERE embedding IS NOT NULL;
CREATE INDEX idx_doc_chunks_parent ON document_chunks(parent_id);
CREATE INDEX idx_kb_ingest_status ON kb_ingest_tasks(status, created_at, id);
CREATE INDEX idx_kb_reembed_status ON kb_reembed_tasks(status, created_at, id);

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
