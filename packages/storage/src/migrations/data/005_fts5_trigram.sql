-- Migration 005: Replace unicode61 FTS5 tokenizer with trigram.
--
-- unicode61 treats a continuous CJK run as one giant token, so queries like
-- "训练方法" never match "训练方法和策略" stored as a single term.
-- trigram tokenizer uses overlapping 3-char windows (language-agnostic),
-- enabling substring search for CJK, mixed ASCII+CJK, and Latin alike.

-- ── Drop old FTS table and its triggers ───────────────────────────────────────
DROP TRIGGER IF EXISTS doc_chunks_fts_ai;
DROP TRIGGER IF EXISTS doc_chunks_fts_ad;
DROP TRIGGER IF EXISTS doc_chunks_fts_au;
DROP TABLE  IF EXISTS document_chunks_fts;

-- ── Recreate FTS5 with trigram tokenizer ──────────────────────────────────────
-- case_sensitive 0 — normalises ASCII to lower before windowing (CJK unaffected).
-- Minimum query term length for trigram is 3 characters; shorter terms are
-- guarded in the application layer (searchFts returns [] if all terms < 3 chars).
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  text,
  chunk_id  UNINDEXED,
  asset_id  UNINDEXED,
  tokenize  = 'trigram case_sensitive 0'
);

-- ── Re-populate from existing rows ────────────────────────────────────────────
INSERT INTO document_chunks_fts(rowid, text, chunk_id, asset_id)
SELECT rowid, text, id, asset_id FROM document_chunks;

-- ── Recreate triggers ─────────────────────────────────────────────────────────
CREATE TRIGGER doc_chunks_fts_ai
AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(rowid, text, chunk_id, asset_id)
  VALUES (NEW.rowid, NEW.text, NEW.id, NEW.asset_id);
END;

CREATE TRIGGER doc_chunks_fts_ad
AFTER DELETE ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(document_chunks_fts, rowid, text, chunk_id, asset_id)
  VALUES ('delete', OLD.rowid, OLD.text, OLD.id, OLD.asset_id);
END;

CREATE TRIGGER doc_chunks_fts_au
AFTER UPDATE OF text ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(document_chunks_fts, rowid, text, chunk_id, asset_id)
  VALUES ('delete', OLD.rowid, OLD.text, OLD.id, OLD.asset_id);
  INSERT INTO document_chunks_fts(rowid, text, chunk_id, asset_id)
  VALUES (NEW.rowid, NEW.text, NEW.id, NEW.asset_id);
END;
