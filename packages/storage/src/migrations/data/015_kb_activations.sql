-- ── KB activation log ───────────────────────────────────────────────────────
--
-- One row per (kb_search call × selected KB document). Replaces the denormalized
-- ideas of sessions.kb_search_count / document_assets.session_usage_json — an
-- unbounded many-to-many (a session uses many KBs; a KB is used in many sessions)
-- belongs in its own table, not a growing JSON column.
--
--   call_id   — groups the rows produced by ONE kb_search call, so "how many KB
--               calls in this session" = COUNT(DISTINCT call_id), not row count.
--   asset_id  — FK → document_assets, ON DELETE CASCADE (deleting a KB doc wipes
--               its activation history).
--   session_id— FK → sessions, ON DELETE CASCADE (deleting a session wipes its
--               activations). This is the one the user asked for explicitly.
--   turn_id   — plain TEXT, no FK: turns already cascade from sessions, and a
--               subagent's turnId is not a real turns row, so an FK would 违约.
--
-- document_assets.use_count / last_activated_at (migration 011) stay as the
-- denormalized counters the list UI reads; this table is the detail/audit source.

CREATE TABLE kb_activations (
  id          TEXT    PRIMARY KEY,
  call_id     TEXT    NOT NULL,
  asset_id    TEXT    NOT NULL REFERENCES document_assets(id) ON DELETE CASCADE,
  session_id  TEXT    NOT NULL REFERENCES sessions(id)        ON DELETE CASCADE,
  turn_id     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_kb_act_session ON kb_activations(session_id);
CREATE INDEX idx_kb_act_asset   ON kb_activations(asset_id);
CREATE INDEX idx_kb_act_call    ON kb_activations(call_id);
