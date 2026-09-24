DROP TRIGGER trg_agent_runs_owner_insert;
DROP TRIGGER trg_agent_runs_owner_update;

DROP INDEX idx_agent_runs_parent_run;
DROP INDEX idx_agent_runs_parent_turn;
DROP INDEX idx_agent_runs_session;
DROP INDEX idx_agent_runs_status;
DROP INDEX idx_tool_executions_agent_run;

ALTER TABLE agent_runs RENAME TO subagents;
ALTER TABLE subagents DROP COLUMN parent_agent_run_id;

ALTER TABLE agent_run_messages RENAME TO previous_subagent_messages;

CREATE TABLE subagent_messages (
  id                            TEXT    PRIMARY KEY,
  subagent_id                   TEXT    NOT NULL REFERENCES subagents(id) ON DELETE CASCADE,
  role                          TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  kind                          TEXT    NOT NULL
                                CHECK (kind IN ('normal', 'tool_results', 'summary', 'continuation', 'reminder')),
  blocks_json                   TEXT    NOT NULL,
  interrupted                   INTEGER NOT NULL DEFAULT 0,
  sequence                      INTEGER NOT NULL,
  created_at                    INTEGER NOT NULL,
  summarized_through_message_id TEXT,
  UNIQUE (subagent_id, sequence)
);

INSERT INTO subagent_messages (
  id, subagent_id, role, kind, blocks_json, interrupted, sequence, created_at,
  summarized_through_message_id
)
SELECT
  id,
  agent_run_id,
  CASE role WHEN 'assistant' THEN 'assistant' ELSE 'user' END,
  CASE role WHEN 'assistant' THEN 'normal' ELSE 'tool_results' END,
  CASE role WHEN 'assistant' THEN content_json ELSE json_array(json(content_json)) END,
  0,
  sequence,
  created_at,
  NULL
FROM previous_subagent_messages;

DROP TABLE previous_subagent_messages;

ALTER TABLE tool_executions RENAME COLUMN agent_run_id TO subagent_id;

CREATE INDEX idx_subagents_parent_turn
  ON subagents(parent_turn_id, created_at ASC, id ASC);

CREATE INDEX idx_subagents_session
  ON subagents(session_id, created_at DESC, id DESC);

CREATE INDEX idx_subagents_status
  ON subagents(status, created_at ASC, id ASC);

CREATE INDEX idx_tool_executions_subagent
  ON tool_executions(subagent_id, created_at ASC, call_id ASC)
  WHERE subagent_id IS NOT NULL;

CREATE TRIGGER trg_subagents_owner_insert
BEFORE INSERT ON subagents
WHEN NOT EXISTS (
  SELECT 1 FROM turns t
  WHERE t.id = NEW.parent_turn_id
    AND t.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: subagents.parent_turn_id');
END;

CREATE TRIGGER trg_subagents_owner_update
BEFORE UPDATE OF session_id, parent_turn_id ON subagents
BEGIN
  SELECT CASE WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: subagents.session_id is immutable') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM turns t
    WHERE t.id = NEW.parent_turn_id
      AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: subagents.parent_turn_id') END;
END;
