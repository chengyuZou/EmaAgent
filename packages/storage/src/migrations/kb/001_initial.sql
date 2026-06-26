-- ════════════════════════════════════════════════════════════════════════════
-- KB stream — one kb.db per named knowledge base.
--
-- Each named KB (registered in profile.db.knowledge_bases) is a self-contained
-- folder holding this kb.db + a files/ directory of copied originals. Nothing
-- here references sessions/turns — those live in data.db. "Which session used
-- which KB doc" is tracked by data.db.kb_activations (by plain kb_id/asset_id).
-- ════════════════════════════════════════════════════════════════════════════

-- ── Documents ──────────────────────────────────────────────────────────────────

CREATE TABLE document_assets (
  id                TEXT    PRIMARY KEY,
  file_path         TEXT    NOT NULL,        -- path to the copied original (relative to {kb}/files)
  file_name         TEXT    NOT NULL,
  mime_type         TEXT    NOT NULL,
  title             TEXT,
  word_count        INTEGER NOT NULL DEFAULT 0,
  page_count        INTEGER,
  status            TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'indexing', 'indexed', 'error')),
  content_hash      TEXT,
  ebd_model         TEXT,                    -- embedding model this doc was indexed with
  ebd_dim           INTEGER,
  ebd_stale         INTEGER NOT NULL DEFAULT 0,
  use_count         INTEGER NOT NULL DEFAULT 0,
  last_activated_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_doc_assets_status    ON document_assets(status);
CREATE INDEX idx_doc_assets_hash      ON document_assets(content_hash);
CREATE INDEX idx_doc_assets_ebd_stale ON document_assets(ebd_stale) WHERE ebd_stale = 1;
CREATE INDEX idx_doc_assets_created   ON document_assets(created_at DESC);
CREATE INDEX idx_doc_assets_lastact   ON document_assets(last_activated_at);

CREATE TABLE document_chunks (
  id                TEXT    PRIMARY KEY,
  asset_id          TEXT    NOT NULL REFERENCES document_assets(id) ON DELETE CASCADE,
  text              TEXT    NOT NULL,
  tokens            TEXT    NOT NULL DEFAULT '',   -- jieba-segmented copy, fed to FTS5
  markdown          TEXT,
  block_kinds_json  TEXT    NOT NULL DEFAULT '[]',
  token_count       INTEGER NOT NULL DEFAULT 0,
  page              INTEGER,
  section_path_json TEXT    NOT NULL DEFAULT '[]',
  prev_id           TEXT,
  next_id           TEXT,
  mom_id            TEXT,                          -- parent ("mom") window id (small-to-big)
  mom_text          TEXT,                          -- full parent-window text carried on each child
  embedding         BLOB                           -- Float32 binary: 4 bytes × dim
);

CREATE INDEX idx_doc_chunks_asset ON document_chunks(asset_id);
CREATE INDEX idx_doc_chunks_mom   ON document_chunks(mom_id);

CREATE TABLE document_previews (
  asset_id        TEXT    PRIMARY KEY REFERENCES document_assets(id) ON DELETE CASCADE,
  text            TEXT    NOT NULL DEFAULT '',
  thumbnail       BLOB,
  thumbnail_mime  TEXT,
  page_count      INTEGER,
  word_count      INTEGER NOT NULL DEFAULT 0
);

-- ── FTS5 (jieba word-segmented BM25) ───────────────────────────────────────────
-- `tokens` holds jieba-segmented text; triggers keep the index in sync.

CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  tokens,
  chunk_id  UNINDEXED,
  asset_id  UNINDEXED,
  tokenize  = 'unicode61 remove_diacritics 1'
);

CREATE TRIGGER doc_chunks_fts_ai
AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(rowid, tokens, chunk_id, asset_id)
  VALUES (NEW.rowid, NEW.tokens, NEW.id, NEW.asset_id);
END;

CREATE TRIGGER doc_chunks_fts_ad
AFTER DELETE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER doc_chunks_fts_au
AFTER UPDATE OF tokens ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE rowid = OLD.rowid;
  INSERT INTO document_chunks_fts(rowid, tokens, chunk_id, asset_id)
  VALUES (NEW.rowid, NEW.tokens, NEW.id, NEW.asset_id);
END;

-- ── Ingest queue (per-KB background indexing) ──────────────────────────────────

CREATE TABLE kb_ingest_tasks (
  id          TEXT    PRIMARY KEY,
  file_path   TEXT    NOT NULL,
  file_name   TEXT    NOT NULL,
  mime_type   TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'failed')),
  stage       TEXT,
  progress    REAL    NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_kb_ingest_status ON kb_ingest_tasks(status, created_at);
