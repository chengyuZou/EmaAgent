-- 子 Agent 执行从旧 AgentTask 语义迁为 AgentRun，并删除重复的根 Turn 投影。

CREATE TABLE agent_runs (
  id                  TEXT    PRIMARY KEY,
  session_id          TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_turn_id      TEXT    NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  parent_agent_run_id TEXT    REFERENCES agent_runs(id) ON DELETE SET NULL,
  task_id             TEXT,
  kind                TEXT    NOT NULL CHECK (kind IN ('subagent', 'fork')),
  purpose             TEXT,
  provider_config_id  TEXT,
  model_id            TEXT,
  status              TEXT    NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  error               TEXT,
  iterations          INTEGER,
  tool_call_count     INTEGER,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  output_excerpt      TEXT,
  version             INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);

CREATE INDEX idx_agent_runs_session
  ON agent_runs(session_id, created_at DESC, id DESC);
CREATE INDEX idx_agent_runs_parent_turn
  ON agent_runs(parent_turn_id, created_at ASC, id ASC);
CREATE INDEX idx_agent_runs_parent_run
  ON agent_runs(parent_agent_run_id);
CREATE INDEX idx_agent_runs_task
  ON agent_runs(task_id, created_at ASC, id ASC)
  WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX idx_agent_runs_one_active_per_task
  ON agent_runs(task_id)
  WHERE task_id IS NOT NULL AND status = 'running';
CREATE INDEX idx_agent_runs_status
  ON agent_runs(status, created_at ASC, id ASC);

-- 旧表同时保存根 Turn 投影和子 Agent。只有 turn_id IS NULL 的行是真实子执行；
-- parent_id 在旧实现中保存父 Turn ID，并不是父 AgentTask ID。
INSERT INTO agent_runs (
  id, session_id, parent_turn_id, parent_agent_run_id, task_id,
  kind, purpose, provider_config_id, model_id, status, error,
  iterations, tool_call_count, input_tokens, output_tokens, output_excerpt,
  version, created_at, updated_at, completed_at
)
SELECT
  id, session_id, parent_id, NULL, NULL,
  'subagent', NULL, NULL, NULL, status, error,
  iterations, NULL, input_tokens, output_tokens, NULL,
  version, created_at, updated_at,
  CASE WHEN status IN ('completed', 'failed', 'cancelled') THEN updated_at ELSE NULL END
FROM agent_tasks
WHERE turn_id IS NULL
  AND parent_id IS NOT NULL;

CREATE TABLE agent_run_messages (
  id           TEXT    PRIMARY KEY,
  agent_run_id TEXT    NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  role         TEXT    NOT NULL CHECK (role IN ('assistant', 'tool_call', 'tool_result', 'reasoning', 'coordinator')),
  content_json TEXT    NOT NULL,
  sequence     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (agent_run_id, sequence)
);

INSERT INTO agent_run_messages (
  id, agent_run_id, role, content_json, sequence, created_at
)
SELECT
  m.id, m.task_id, m.role, m.content_json, m.sequence, m.created_at
FROM agent_task_messages m
JOIN agent_runs r ON r.id = m.task_id;

CREATE INDEX idx_agent_run_messages_sequence
  ON agent_run_messages(agent_run_id, sequence ASC);

-- 工具日志仍归属父 Turn，同时记录可选的子 Agent 执行身份，避免拿 Run ID 冒充 Turn ID。
ALTER TABLE tool_executions
  ADD COLUMN agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL;

CREATE INDEX idx_tool_executions_agent_run
  ON tool_executions(agent_run_id, created_at ASC, call_id ASC)
  WHERE agent_run_id IS NOT NULL;

-- v7 的 Turn 删除触发器直接引用旧表；AgentRun 已用 parent_turn_id 外键级联，
-- 因此重建触发器后只需继续处理历史上没有单列外键的 KB activation。
DROP TRIGGER trg_turns_owner_delete_cleanup;

CREATE TRIGGER trg_turns_owner_delete_cleanup
AFTER DELETE ON turns
BEGIN
  UPDATE kb_activations
     SET turn_id = NULL
   WHERE turn_id = OLD.id AND session_id = OLD.session_id;
END;

DROP TABLE agent_task_messages;
DROP TABLE agent_tasks;

CREATE TRIGGER trg_agent_runs_owner_insert
BEFORE INSERT ON agent_runs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM turns t
    WHERE t.id = NEW.parent_turn_id
      AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: agent_runs.parent_turn_id') END;

  SELECT CASE WHEN NEW.parent_agent_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_runs p
    WHERE p.id = NEW.parent_agent_run_id
      AND p.session_id = NEW.session_id
      AND p.parent_turn_id = NEW.parent_turn_id
  ) THEN RAISE(ABORT, 'ownership_violation: agent_runs.parent_agent_run_id') END;
END;

CREATE TRIGGER trg_agent_runs_owner_update
BEFORE UPDATE OF session_id, parent_turn_id, parent_agent_run_id ON agent_runs
BEGIN
  SELECT CASE WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: agent_runs.session_id is immutable') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM turns t
    WHERE t.id = NEW.parent_turn_id
      AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: agent_runs.parent_turn_id') END;

  SELECT CASE WHEN NEW.parent_agent_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_runs p
    WHERE p.id = NEW.parent_agent_run_id
      AND p.session_id = NEW.session_id
      AND p.parent_turn_id = NEW.parent_turn_id
  ) THEN RAISE(ABORT, 'ownership_violation: agent_runs.parent_agent_run_id') END;
END;
