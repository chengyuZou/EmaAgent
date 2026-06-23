-- 013: add turn_attachments table (was in 001_initial but missed on existing DBs)
CREATE TABLE IF NOT EXISTS turn_attachments (
  id         TEXT    PRIMARY KEY,
  turn_id    TEXT    NOT NULL REFERENCES turns(id)    ON DELETE CASCADE,
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  mime       TEXT    NOT NULL,
  size       INTEGER NOT NULL,
  mtime      INTEGER NOT NULL,
  local_path TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_attachments_turn    ON turn_attachments(turn_id);
CREATE INDEX IF NOT EXISTS idx_turn_attachments_session ON turn_attachments(session_id, created_at DESC);
