-- 014: fix the document_chunks FTS sync triggers.
--
-- document_chunks_fts is a REGULAR fts5 table (content is stored inside it).
-- The delete/update triggers (from 004, kept in 009) used the external-content
-- 'delete' command: INSERT INTO fts(fts, rowid, …) VALUES('delete', …).
-- That command is only valid for content='' / external-content tables, so on a
-- regular fts5 table every chunk delete/update raised "SQL logic error" — which
-- aborted KB document deletion (cascade → delete chunks → trigger → error).
-- Regular fts5 tables must use a plain DELETE by rowid.

DROP TRIGGER IF EXISTS doc_chunks_fts_ad;
DROP TRIGGER IF EXISTS doc_chunks_fts_au;

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
