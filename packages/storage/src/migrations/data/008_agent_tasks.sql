-- ── Agent task tables ──────────────────────────────────────────────────────────
--
-- Replaces the JSONL-based TranscriptJournal.
--
--   agent_tasks         — one row per agent run (root turns + subagent spawns).
--                         Status transitions replace JSONL lifecycle events.
--                         Crash recovery: SELECT WHERE status IN ('running','waiting_user').
--
--   agent_task_messages — subagent conversation transcript, written by the SSE
--                         fan-out in turns.ts (not the engine — architecture red line).
--                         ON DELETE CASCADE so removing a task wipes its messages.

CREATE TABLE agent_tasks (
  id                     TEXT    PRIMARY KEY,
  session_id             TEXT    NOT NULL,
  turn_id                TEXT,             -- NULL for subagent tasks (no DB turn row)
  parent_id              TEXT,             -- NULL for root tasks
  status                 TEXT    NOT NULL DEFAULT 'running'
                                   CHECK (status IN (
                                     'running','waiting_user','completed','failed','cancelled'
                                   )),
  pending_prompt_id      TEXT,
  pending_questions_json TEXT,
  error                  TEXT,
  iterations             INTEGER,
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX idx_agent_tasks_session ON agent_tasks(session_id, created_at DESC);
CREATE INDEX idx_agent_tasks_parent  ON agent_tasks(parent_id);
CREATE INDEX idx_agent_tasks_status  ON agent_tasks(status);

CREATE TABLE agent_task_messages (
  id           TEXT    PRIMARY KEY,
  task_id      TEXT    NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  -- 'assistant' = accumulated text block; 'tool_call' = dispatched call; 'tool_result' = resolved result
  role         TEXT    NOT NULL CHECK (role IN ('assistant','tool_call','tool_result')),
  content_json TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_atm_task_created ON agent_task_messages(task_id, created_at ASC);
