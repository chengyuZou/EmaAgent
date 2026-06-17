-- ── Session status tracking ──────────────────────────────────────────────────
--
-- last_viewed_at: unix-ms timestamp of when the user last opened this session.
-- Used to compute has_unread: completed turns after this timestamp are "new".
-- NULL = never explicitly viewed (treat as 0 for comparison purposes).

ALTER TABLE sessions ADD COLUMN last_viewed_at INTEGER;
