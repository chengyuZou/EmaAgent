-- ── Migration 007: reserve 'subagent_run' kind in background_tasks ──────────
--
-- Round 5A scaffolding. The actual sub-agent runtime is V1.5 work — this
-- migration just opens the CHECK constraint so the future kind value can be
-- inserted without a schema change. No data manipulation, no other table
-- changes.
--
-- SQLite can't ALTER a CHECK constraint in place; we rebuild the table.

CREATE TABLE background_tasks_v7 (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK(kind IN (
                  'extraction', 'consolidation', 'compaction',
                  'embedding_refresh',
                  'subagent_run'              -- NEW (V1.5 placeholder)
                )),
  status        TEXT NOT NULL CHECK(status IN (
                  'pending', 'running', 'completed', 'failed'
                )),
  session_id    TEXT,
  payload_json  TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

INSERT INTO background_tasks_v7 SELECT * FROM background_tasks;

DROP TABLE  background_tasks;
ALTER TABLE background_tasks_v7 RENAME TO background_tasks;

CREATE INDEX idx_bgtasks_status_created ON background_tasks(status, created_at);
CREATE INDEX idx_bgtasks_session        ON background_tasks(session_id);
