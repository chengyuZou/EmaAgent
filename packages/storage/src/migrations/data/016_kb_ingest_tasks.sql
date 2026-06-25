-- ── KB ingest task queue ────────────────────────────────────────────────────
--
-- Persistent background-ingest queue (like memory_tasks / agent_tasks). One row
-- per file submitted for indexing. A concurrency-limited worker in apps/core
-- drains `pending` rows. Survives restart: failed rows keep their error so the
-- UI can offer a retry button after the app reopens; `running` rows interrupted
-- by a crash are recovered to `failed` on startup.
--
--   id        — the pre-generated document asset id (so task ↔ resulting doc match)
--   status    — pending → running → (deleted on success) | failed
--   stage     — last-seen ingest stage (validate/parse/chunk/embed) for the queue UI
--   progress  — 0–1 fraction (last seen)

CREATE TABLE kb_ingest_tasks (
  id          TEXT    PRIMARY KEY,
  file_path   TEXT    NOT NULL,
  file_name   TEXT    NOT NULL,
  mime_type   TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'failed')),
  stage       TEXT,
  progress    REAL    NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_kb_ingest_status ON kb_ingest_tasks(status, created_at);
