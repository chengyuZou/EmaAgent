-- Migration 009: jieba word-segmented FTS5 (replaces trigram).
--
-- trigram (migration 005) windows text into 3-char grams — language-agnostic but
-- has a hard 3-character minimum, so 2-char Chinese words (记忆/检索/模型/训练…)
-- never index or match, and substring windows cause cross-word false positives.
--
-- jieba segments Chinese into real words (general dict from @node-rs/jieba/dict,
-- the portable equivalent of RAGFlow's trie dict). We materialize the segmented
-- text into document_chunks.tokens (computed in the repo at insert time, since
-- SQL triggers can't call jieba), then index that column with unicode61 so BM25
-- scores over whole words. Latin text is unaffected (already space-delimited;
-- jieba leaves ASCII runs intact).

-- ── Add the segmented-tokens column (repo populates it on insert) ──────────────
ALTER TABLE document_chunks ADD COLUMN tokens TEXT NOT NULL DEFAULT '';

-- ── Drop the trigram FTS table and its triggers ───────────────────────────────
DROP TRIGGER IF EXISTS doc_chunks_fts_ai;
DROP TRIGGER IF EXISTS doc_chunks_fts_ad;
DROP TRIGGER IF EXISTS doc_chunks_fts_au;
DROP TABLE  IF EXISTS document_chunks_fts;

-- ── Recreate FTS5 over the segmented tokens with a whitespace-splitting tokenizer ─
-- unicode61 now sees space-separated words (from jieba) → real word-level BM25.
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  tokens,
  chunk_id  UNINDEXED,
  asset_id  UNINDEXED,
  tokenize  = 'unicode61 remove_diacritics 1'
);

-- ── Re-populate from existing rows (no-op on a fresh rebuild) ──────────────────
INSERT INTO document_chunks_fts(rowid, tokens, chunk_id, asset_id)
SELECT rowid, tokens, id, asset_id FROM document_chunks;

-- ── Triggers keep FTS in sync; they copy the pre-segmented tokens column ───────
CREATE TRIGGER doc_chunks_fts_ai
AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(rowid, tokens, chunk_id, asset_id)
  VALUES (NEW.rowid, NEW.tokens, NEW.id, NEW.asset_id);
END;

CREATE TRIGGER doc_chunks_fts_ad
AFTER DELETE ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(document_chunks_fts, rowid, tokens, chunk_id, asset_id)
  VALUES ('delete', OLD.rowid, OLD.tokens, OLD.id, OLD.asset_id);
END;

CREATE TRIGGER doc_chunks_fts_au
AFTER UPDATE OF tokens ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(document_chunks_fts, rowid, tokens, chunk_id, asset_id)
  VALUES ('delete', OLD.rowid, OLD.tokens, OLD.id, OLD.asset_id);
  INSERT INTO document_chunks_fts(rowid, tokens, chunk_id, asset_id)
  VALUES (NEW.rowid, NEW.tokens, NEW.id, NEW.asset_id);
END;
