-- 后台 Shell 使用独立状态表；命令只执行一次，重启后不会认领或重放旧进程。
-- ema:migration foreign_keys=off

PRAGMA legacy_alter_table = ON;

ALTER TABLE turns RENAME TO turns_before_background_trigger;

CREATE TABLE turns (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status               TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','aborted')),
  user_input           TEXT NOT NULL,
  started_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  error_code           TEXT,
  error_message        TEXT,
  iterations           INTEGER NOT NULL DEFAULT 0,
  usage_input_tokens   INTEGER NOT NULL DEFAULT 0,
  usage_output_tokens  INTEGER NOT NULL DEFAULT 0,
  trigger_type         TEXT NOT NULL DEFAULT 'userMessage'
                       CHECK(trigger_type IN ('userMessage','backgroundProcessCompleted')),
  execution_profile    TEXT NOT NULL DEFAULT 'chat'
                       CHECK(execution_profile IN ('chat','work')),
  narrative_policy     TEXT NOT NULL DEFAULT 'auto'
                       CHECK(narrative_policy IN ('auto','always','off'))
);

INSERT INTO turns (
  id, session_id, status, user_input, started_at, completed_at,
  error_code, error_message, iterations, usage_input_tokens, usage_output_tokens,
  trigger_type, execution_profile, narrative_policy
)
SELECT
  id, session_id, status, user_input, started_at, completed_at,
  error_code, error_message, iterations, usage_input_tokens, usage_output_tokens,
  trigger_type, execution_profile, narrative_policy
FROM turns_before_background_trigger;

DROP TABLE turns_before_background_trigger;

CREATE INDEX idx_turns_session ON turns(session_id, started_at);
CREATE INDEX idx_turns_status ON turns(status);
CREATE INDEX idx_turns_session_latest
  ON turns(session_id, started_at DESC, id DESC);
CREATE INDEX idx_turns_running_by_session
  ON turns(session_id)
  WHERE status IN ('pending', 'running');

CREATE TRIGGER trg_turns_owner_update
BEFORE UPDATE OF session_id ON turns
WHEN NEW.session_id <> OLD.session_id
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: turns.session_id is immutable');
END;

CREATE TRIGGER trg_turns_owner_delete_cleanup
AFTER DELETE ON turns
BEGIN
  DELETE FROM messages WHERE turn_id = OLD.id;
END;

CREATE TABLE background_processes (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  origin_turn_id        TEXT REFERENCES turns(id) ON DELETE SET NULL,
  tool_call_id          TEXT REFERENCES tool_executions(call_id) ON DELETE SET NULL,
  command               TEXT NOT NULL,
  description           TEXT,
  cwd                   TEXT NOT NULL,
  status                TEXT NOT NULL CHECK(status IN (
                          'queued','running','completed','failed',
                          'timedOut','stopped','interrupted'
                        )),
  timeout_ms            INTEGER NOT NULL CHECK(timeout_ms > 0),
  version               INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  created_at            INTEGER NOT NULL,
  started_at            INTEGER,
  completed_at          INTEGER,
  exit_code             INTEGER,
  termination_reason    TEXT,
  stdout_bytes          INTEGER NOT NULL DEFAULT 0 CHECK(stdout_bytes >= 0),
  stderr_bytes          INTEGER NOT NULL DEFAULT 0 CHECK(stderr_bytes >= 0),
  output_truncated      INTEGER NOT NULL DEFAULT 0 CHECK(output_truncated IN (0, 1)),
  output_relative_path  TEXT NOT NULL,
  completion_claimed_at INTEGER,
  continuation_turn_id  TEXT,
  model_notified_at     INTEGER
);

CREATE INDEX idx_background_processes_session
  ON background_processes(session_id, created_at DESC, id DESC);
CREATE INDEX idx_background_processes_recovery
  ON background_processes(status, created_at, id);
CREATE INDEX idx_background_processes_completion
  ON background_processes(session_id, model_notified_at, completion_claimed_at, completed_at, id);
CREATE INDEX idx_background_processes_continuation
  ON background_processes(continuation_turn_id, id)
  WHERE continuation_turn_id IS NOT NULL;

CREATE TRIGGER trg_background_processes_owner_insert
BEFORE INSERT ON background_processes
BEGIN
  SELECT CASE
    WHEN NEW.origin_turn_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.origin_turn_id AND t.session_id = NEW.session_id
    )
    THEN RAISE(ABORT, 'ownership_violation: background_processes.origin_turn_id')
  END;
  SELECT CASE
    WHEN NEW.tool_call_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM tool_executions e
       WHERE e.call_id = NEW.tool_call_id AND e.session_id = NEW.session_id
    )
    THEN RAISE(ABORT, 'ownership_violation: background_processes.tool_call_id')
  END;
END;

CREATE TRIGGER trg_background_processes_identity_update
BEFORE UPDATE OF id, session_id, origin_turn_id, tool_call_id, command, cwd, timeout_ms, output_relative_path
ON background_processes
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
      OR NEW.session_id <> OLD.session_id
      OR NEW.origin_turn_id IS NOT OLD.origin_turn_id
      OR NEW.tool_call_id IS NOT OLD.tool_call_id
      OR NEW.command <> OLD.command
      OR NEW.cwd <> OLD.cwd
      OR NEW.timeout_ms <> OLD.timeout_ms
      OR NEW.output_relative_path <> OLD.output_relative_path
    THEN RAISE(ABORT, 'ownership_violation: background process identity is immutable')
  END;
END;

PRAGMA legacy_alter_table = OFF;
