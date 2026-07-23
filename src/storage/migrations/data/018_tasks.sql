-- 用户与模型可见的 Task 使用独立表、Session 内短序号和显式依赖关系。

CREATE TABLE tasks (
  id                   TEXT    PRIMARY KEY,
  session_id           TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  display_number       INTEGER NOT NULL CHECK (display_number > 0),
  subject              TEXT    NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  description          TEXT    NOT NULL CHECK (length(description) BETWEEN 1 AND 20000),
  active_form          TEXT    CHECK (active_form IS NULL OR length(active_form) BETWEEN 1 AND 200),
  status               TEXT    NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  created_by_turn_id   TEXT    NOT NULL REFERENCES turns(id) ON DELETE RESTRICT,
  completed_by_turn_id TEXT    REFERENCES turns(id) ON DELETE SET NULL,
  version              INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  CHECK (
    (
      status IN ('completed', 'cancelled')
      AND completed_by_turn_id IS NOT NULL
      AND completed_at IS NOT NULL
    )
    OR
    (
      status IN ('pending', 'in_progress')
      AND completed_by_turn_id IS NULL
      AND completed_at IS NULL
    )
  ),
  UNIQUE (session_id, display_number),
  UNIQUE (session_id, id)
);

CREATE INDEX idx_tasks_session_status
  ON tasks(session_id, status, display_number ASC);
CREATE INDEX idx_tasks_session_updated
  ON tasks(session_id, updated_at DESC, id DESC);

CREATE TABLE task_dependencies (
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  blocker_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (blocker_task_id, blocked_task_id),
  CHECK (blocker_task_id <> blocked_task_id)
);

CREATE INDEX idx_task_dependencies_blocked
  ON task_dependencies(blocked_task_id, blocker_task_id);
CREATE INDEX idx_task_dependencies_session
  ON task_dependencies(session_id, blocked_task_id, blocker_task_id);

CREATE TABLE task_context_state (
  session_id       TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  last_reminded_at INTEGER NOT NULL
);

CREATE TRIGGER trg_tasks_owner_insert
BEFORE INSERT ON tasks
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM turns t
     WHERE t.id = NEW.created_by_turn_id
       AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: tasks.created_by_turn_id') END;

  SELECT CASE WHEN NEW.completed_by_turn_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM turns t
     WHERE t.id = NEW.completed_by_turn_id
       AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: tasks.completed_by_turn_id') END;
END;

CREATE TRIGGER trg_tasks_owner_update
BEFORE UPDATE OF session_id, created_by_turn_id, completed_by_turn_id ON tasks
BEGIN
  SELECT CASE WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: tasks.session_id is immutable') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM turns t
     WHERE t.id = NEW.created_by_turn_id
       AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: tasks.created_by_turn_id') END;

  SELECT CASE WHEN NEW.completed_by_turn_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM turns t
     WHERE t.id = NEW.completed_by_turn_id
       AND t.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: tasks.completed_by_turn_id') END;
END;

CREATE TRIGGER trg_task_dependencies_owner_insert
BEFORE INSERT ON task_dependencies
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM tasks blocker
     WHERE blocker.id = NEW.blocker_task_id
       AND blocker.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: task_dependencies.blocker_task_id') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM tasks blocked
     WHERE blocked.id = NEW.blocked_task_id
       AND blocked.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: task_dependencies.blocked_task_id') END;
END;

-- AgentRun 可以关联已有工作项，但只能绑定同 Session、未终态且依赖已完成的 Task。
CREATE TRIGGER trg_agent_runs_task_insert
BEFORE INSERT ON agent_runs
WHEN NEW.task_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM tasks task
     WHERE task.id = NEW.task_id
       AND task.session_id = NEW.session_id
       AND task.status IN ('pending', 'in_progress')
  ) THEN RAISE(ABORT, 'task_binding_invalid: task unavailable') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM task_dependencies dependency
      JOIN tasks blocker ON blocker.id = dependency.blocker_task_id
     WHERE dependency.blocked_task_id = NEW.task_id
       AND blocker.status <> 'completed'
  ) THEN RAISE(ABORT, 'task_binding_invalid: unresolved dependency') END;
END;

CREATE TRIGGER trg_agent_runs_task_update
BEFORE UPDATE OF task_id, session_id ON agent_runs
WHEN NEW.task_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM tasks task
     WHERE task.id = NEW.task_id
       AND task.session_id = NEW.session_id
       AND task.status IN ('pending', 'in_progress')
  ) THEN RAISE(ABORT, 'task_binding_invalid: task unavailable') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM task_dependencies dependency
      JOIN tasks blocker ON blocker.id = dependency.blocker_task_id
     WHERE dependency.blocked_task_id = NEW.task_id
       AND blocker.status <> 'completed'
  ) THEN RAISE(ABORT, 'task_binding_invalid: unresolved dependency') END;
END;

-- 终态工作项不能仍由子 Agent 执行，避免 UI 同时显示“已完成”和“运行中”。
CREATE TRIGGER trg_tasks_terminal_with_active_run
BEFORE UPDATE OF status ON tasks
WHEN NEW.status IN ('completed', 'cancelled')
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM agent_runs run
     WHERE run.task_id = NEW.id
       AND run.status = 'running'
  ) THEN RAISE(ABORT, 'task_transition_conflict: active agent run') END;
END;

-- 物理删除是显式操作；历史 AgentRun 保留，但解除已不存在的工作项引用。
CREATE TRIGGER trg_tasks_delete_cleanup
BEFORE DELETE ON tasks
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM agent_runs run
     WHERE run.task_id = OLD.id
       AND run.status = 'running'
  ) THEN RAISE(ABORT, 'task_transition_conflict: active agent run') END;

  UPDATE agent_runs
     SET task_id = NULL
   WHERE task_id = OLD.id;
END;
