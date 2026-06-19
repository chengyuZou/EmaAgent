CREATE TABLE IF NOT EXISTS document_assets (
  id           TEXT    PRIMARY KEY,
  scope        TEXT    NOT NULL CHECK (scope IN ('global', 'session')),
  session_id   TEXT,
  file_path    TEXT    NOT NULL,
  file_name    TEXT    NOT NULL,
  mime_type    TEXT    NOT NULL,
  title        TEXT,
  word_count   INTEGER NOT NULL DEFAULT 0,
  page_count   INTEGER,
  status       TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'indexing', 'indexed', 'error')),
  content_hash TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id                TEXT    PRIMARY KEY,
  asset_id          TEXT    NOT NULL
                    REFERENCES document_assets(id) ON DELETE CASCADE,
  text              TEXT    NOT NULL,
  markdown          TEXT,
  block_kinds_json  TEXT    NOT NULL DEFAULT '[]',
  token_count       INTEGER NOT NULL DEFAULT 0,
  page              INTEGER,
  section_path_json TEXT    NOT NULL DEFAULT '[]',
  prev_id           TEXT,
  next_id           TEXT,
  -- Float32 binary: 4 bytes × dim; more efficient than JSON text
  embedding         BLOB
);

CREATE TABLE IF NOT EXISTS document_previews (
  asset_id        TEXT    PRIMARY KEY
                  REFERENCES document_assets(id) ON DELETE CASCADE,
  text            TEXT    NOT NULL DEFAULT '',
  thumbnail       BLOB,
  thumbnail_mime  TEXT,
  page_count      INTEGER,
  word_count      INTEGER NOT NULL DEFAULT 0
);

-- ── Indexes ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_doc_chunks_asset  ON document_chunks(asset_id);
CREATE INDEX IF NOT EXISTS idx_doc_assets_scope  ON document_assets(scope, session_id);
CREATE INDEX IF NOT EXISTS idx_doc_assets_status ON document_assets(status);
CREATE INDEX IF NOT EXISTS idx_doc_assets_hash   ON document_assets(content_hash);

-- ── FTS5 virtual table ─────────────────────────────────────────────────────────
-- Replaces the hand-rolled in-memory BM25Index.
-- unicode61 handles Latin/diacritics well; CJK tokens without spaces are treated
-- as single terms (acceptable at V1.5 scale — vector search compensates).
CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
  text,
  chunk_id  UNINDEXED,
  asset_id  UNINDEXED,
  tokenize  = 'unicode61 remove_diacritics 1'
);

-- Triggers keep FTS index in sync with document_chunks automatically.
CREATE TRIGGER IF NOT EXISTS doc_chunks_fts_ai
AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(rowid, text, chunk_id, asset_id)
  VALUES (NEW.rowid, NEW.text, NEW.id, NEW.asset_id);
END;

CREATE TRIGGER IF NOT EXISTS doc_chunks_fts_ad
AFTER DELETE ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(document_chunks_fts, rowid, text, chunk_id, asset_id)
  VALUES ('delete', OLD.rowid, OLD.text, OLD.id, OLD.asset_id);
END;

CREATE TRIGGER IF NOT EXISTS doc_chunks_fts_au
AFTER UPDATE OF text ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(document_chunks_fts, rowid, text, chunk_id, asset_id)
  VALUES ('delete', OLD.rowid, OLD.text, OLD.id, OLD.asset_id);
  INSERT INTO document_chunks_fts(rowid, text, chunk_id, asset_id)
  VALUES (NEW.rowid, NEW.text, NEW.id, NEW.asset_id);
END;
