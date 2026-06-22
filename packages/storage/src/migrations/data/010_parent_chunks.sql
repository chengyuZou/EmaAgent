-- Parent-child (small-to-big) retrieval, RAGFlow-style.
--
-- Children carry their parent window's id + full text (mom_with_weight). No
-- separate parent rows: FTS/embedding still index only the (small) children,
-- while retrieval can substitute the matched child for its larger parent
-- context. mom_id groups children of the same window; mom_text is duplicated
-- across a window's children (cheap, and avoids a parent table + join).

ALTER TABLE document_chunks ADD COLUMN mom_id   TEXT;
ALTER TABLE document_chunks ADD COLUMN mom_text TEXT;

CREATE INDEX IF NOT EXISTS idx_doc_chunks_mom ON document_chunks(mom_id);
