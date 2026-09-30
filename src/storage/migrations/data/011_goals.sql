CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed')),
  version INTEGER NOT NULL CHECK(version >= 1),
  reason TEXT CHECK(reason IN ('succeeded', 'failed', 'cancelled')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (
    (status IN ('active', 'paused') AND reason IS NULL AND error IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND reason IS NOT NULL AND completed_at IS NOT NULL AND (
      (reason IN ('succeeded', 'cancelled') AND error IS NULL)
      OR (reason = 'failed' AND error IS NOT NULL)
    ))
  )
);

-- 暂停仍占当前目标的位置, 只有完成或删除后才允许建立新目标.
CREATE UNIQUE INDEX goals_one_unfinished_per_session
  ON goals(session_id) WHERE status IN ('active', 'paused');

CREATE INDEX goals_session_history ON goals(session_id, created_at DESC, id DESC);
