CREATE TABLE artifacts (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  turn_id          TEXT,
  type             TEXT NOT NULL,
  title            TEXT NOT NULL,
  content          TEXT NOT NULL DEFAULT '',
  content_location TEXT NOT NULL DEFAULT 'inline',  -- 'inline' | 'file'
  content_path     TEXT,
  meta_json        TEXT NOT NULL DEFAULT '{}',
  applied_at       INTEGER,
  rejected_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_session ON artifacts(session_id);