-- ── Session activity time ───────────────────────────────────────────────────
--
-- updated_at is row metadata time: title/group/pin/workspace/mode/meta edits.
-- last_activity_at is conversation activity time: used for "recent sessions"
-- ordering and advanced only when the session receives a new turn/message.

ALTER TABLE sessions ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0;

UPDATE sessions
   SET last_activity_at = COALESCE(
     (
       SELECT MAX(t.started_at)
         FROM turns t
        WHERE t.session_id = sessions.id
     ),
     (
       SELECT MAX(m.created_at)
         FROM messages m
        WHERE m.session_id = sessions.id
     ),
     created_at
   );

DROP INDEX IF EXISTS idx_sessions_list;
CREATE INDEX idx_sessions_list ON sessions(pinned DESC, group_label, last_activity_at DESC);
