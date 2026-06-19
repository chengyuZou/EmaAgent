-- Track which embedding model produced the stored BLOBs.
-- When the user switches providers/models the old BLOBs become semantically
-- invalid (different vector space). Mark them stale so the reembed job can
-- rebuild them in the background without blocking reads.

ALTER TABLE document_assets ADD COLUMN ebd_model TEXT;
ALTER TABLE document_assets ADD COLUMN ebd_dim   INTEGER;
ALTER TABLE document_assets ADD COLUMN ebd_stale INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_doc_assets_ebd_stale
  ON document_assets(ebd_stale)
  WHERE ebd_stale = 1;
