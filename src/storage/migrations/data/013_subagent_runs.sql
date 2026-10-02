-- 将稳定子代理身份与每次执行分开, 不补造旧记录没有保存的起始上下文.
CREATE TABLE subagent_runs (
  id                  TEXT PRIMARY KEY,
  subagent_id         TEXT NOT NULL REFERENCES subagents(id) ON DELETE CASCADE,
  parent_tool_call_id  TEXT UNIQUE,
  context_mode        TEXT NOT NULL CHECK (context_mode IN ('subagent', 'fork')),
  description         TEXT,
  provider_id         TEXT,
  model_id            TEXT,
  protocol            TEXT,
  permission_mode     TEXT CHECK (permission_mode IN ('default', 'acceptEdits', 'bypassPermissions', 'plan')),
  reasoning_effort    TEXT CHECK (reasoning_effort IN ('off', 'low', 'medium', 'high', 'max')),
  status              TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  error               TEXT,
  iterations          INTEGER,
  tool_call_count     INTEGER,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  final_text          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);

INSERT INTO subagent_runs (
  id, subagent_id, parent_tool_call_id, context_mode, description,
  provider_id, model_id, protocol, status, error, iterations, tool_call_count,
  input_tokens, output_tokens, final_text, created_at, updated_at, completed_at
)
SELECT lower(hex(randomblob(16))), s.id, i.tool_call_id, s.context_mode, s.description,
       s.provider_id, s.model_id, NULL, s.status, s.error, s.iterations, s.tool_call_count,
       s.input_tokens, s.output_tokens, s.final_text, s.created_at, s.updated_at, s.completed_at
FROM subagents s
LEFT JOIN subagent_invocations i ON i.subagent_id = s.id;

CREATE UNIQUE INDEX idx_subagent_runs_running
  ON subagent_runs(subagent_id) WHERE status = 'running';
CREATE INDEX idx_subagent_runs_subagent
  ON subagent_runs(subagent_id, created_at DESC, id DESC);

-- 普通 Message 通过 Turn 取得来源. fork 前缀可能来自不同父 Turn,
-- 无法归入本次子代理 Run, 所以仅继承 Assistant 保存原始 Provider/Model/协议.
-- 重建现有消息表以移除 sequence 及其 UNIQUE 约束, 搬迁后恢复原表名.
CREATE TABLE next_subagent_messages (
  id                            TEXT PRIMARY KEY,
  subagent_id                   TEXT NOT NULL REFERENCES subagents(id) ON DELETE CASCADE,
  run_id                        TEXT REFERENCES subagent_runs(id) ON DELETE CASCADE,
  role                          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  kind                          TEXT NOT NULL
                                CHECK (kind IN ('normal', 'tool_results', 'summary', 'continuation', 'reminder')),
  blocks_json                   TEXT NOT NULL,
  interrupted                   INTEGER NOT NULL DEFAULT 0,
  created_at                    INTEGER NOT NULL,
  summarized_through_message_id TEXT,
  summary_saved_tokens          INTEGER,
  provider_id                   TEXT,
  model_id                      TEXT,
  protocol                      TEXT
);

-- 旧消息按 sequence 写入, 同毫秒的时间需要递增才能在删除 sequence 后保留原顺序.
-- 只推进冲突或倒退的时间, 不改变已经递增的时间, 不补造缺失的摘要统计和 fork 来源.
INSERT INTO next_subagent_messages (
  id, subagent_id, run_id, role, kind, blocks_json, interrupted, created_at,
  summarized_through_message_id
)
SELECT m.id, m.subagent_id, r.id, m.role, m.kind, m.blocks_json, m.interrupted,
       MAX(m.created_at - m.sequence) OVER (
         PARTITION BY m.subagent_id ORDER BY m.sequence ROWS UNBOUNDED PRECEDING
       ) + m.sequence,
       m.summarized_through_message_id
FROM subagent_messages m
JOIN subagent_runs r ON r.subagent_id = m.subagent_id;

DROP TABLE subagent_messages;
ALTER TABLE next_subagent_messages RENAME TO subagent_messages;

CREATE INDEX idx_subagent_messages_run
  ON subagent_messages(run_id, created_at ASC, id ASC) WHERE run_id IS NOT NULL;
CREATE INDEX idx_subagent_messages_subagent
  ON subagent_messages(subagent_id, created_at ASC, id ASC);

CREATE TRIGGER trg_subagent_messages_run_insert
BEFORE INSERT ON subagent_messages
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM subagent_runs r WHERE r.id = NEW.run_id AND r.subagent_id = NEW.subagent_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: subagent_messages.run_id');
END;

CREATE TRIGGER trg_subagent_messages_run_update
BEFORE UPDATE OF run_id, subagent_id ON subagent_messages
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM subagent_runs r WHERE r.id = NEW.run_id AND r.subagent_id = NEW.subagent_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: subagent_messages.run_id');
END;

DROP TABLE subagent_invocations;
ALTER TABLE subagents DROP COLUMN context_mode;
ALTER TABLE subagents DROP COLUMN error;
ALTER TABLE subagents DROP COLUMN iterations;
ALTER TABLE subagents DROP COLUMN tool_call_count;
ALTER TABLE subagents DROP COLUMN input_tokens;
ALTER TABLE subagents DROP COLUMN output_tokens;
ALTER TABLE subagents DROP COLUMN final_text;
ALTER TABLE subagents DROP COLUMN completed_at;
ALTER TABLE subagents ADD COLUMN title TEXT;
-- 身份表的配置是最近一次准备成功的 Run 参数, 旧 Run 的实际配置由 Run 表保存.
ALTER TABLE subagents ADD COLUMN protocol TEXT;
ALTER TABLE subagents ADD COLUMN permission_mode TEXT
  CHECK (permission_mode IN ('default', 'acceptEdits', 'bypassPermissions', 'plan'));
ALTER TABLE subagents ADD COLUMN reasoning_effort TEXT
  CHECK (reasoning_effort IN ('off', 'low', 'medium', 'high', 'max'));

CREATE INDEX idx_subagents_session_updated ON subagents(session_id, updated_at DESC, id DESC);
