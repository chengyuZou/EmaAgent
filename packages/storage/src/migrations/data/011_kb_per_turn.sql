-- KB per-turn selection model.
--
-- Drop the global/session SCOPE concept: a document asset is no longer bound to
-- a scope/session. Instead the chat turn explicitly selects which assets (KBs)
-- to search, and we track selection usage on the asset itself:
--   use_count          — how many times this KB has been selected for a turn
--   last_activated_at   — last selection time (NULL → never; UI falls back to created_at)

DROP INDEX IF EXISTS idx_doc_assets_scope;

ALTER TABLE document_assets DROP COLUMN scope;
ALTER TABLE document_assets DROP COLUMN session_id;

ALTER TABLE document_assets ADD COLUMN use_count         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_assets ADD COLUMN last_activated_at INTEGER;

-- Listing is cursor-paginated by recency; stale view sorts by activation recency.
CREATE INDEX IF NOT EXISTS idx_doc_assets_created  ON document_assets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_assets_lastact  ON document_assets(last_activated_at);
