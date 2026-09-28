-- Preserve the compaction estimate with its summary message for history display.
-- Existing summaries have no recorded estimate and keep NULL.
ALTER TABLE messages ADD COLUMN summary_saved_tokens INTEGER;
