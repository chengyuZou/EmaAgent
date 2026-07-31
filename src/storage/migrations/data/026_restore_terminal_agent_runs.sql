-- 历史终态 AgentRun 可以继续引用终态 Task；只有正在运行的 AgentRun 受可执行性约束。

DROP TRIGGER trg_agent_runs_task_insert;
DROP TRIGGER trg_agent_runs_task_update;

CREATE TRIGGER trg_agent_runs_task_insert
BEFORE INSERT ON agent_runs
WHEN NEW.task_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM tasks task
     WHERE task.id = NEW.task_id
       AND task.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'task_binding_invalid: task unavailable') END;

  SELECT CASE WHEN NEW.status = 'running' AND EXISTS (
    SELECT 1 FROM tasks task
     WHERE task.id = NEW.task_id
       AND task.status NOT IN ('pending', 'in_progress')
  ) THEN RAISE(ABORT, 'task_binding_invalid: task unavailable') END;

  SELECT CASE WHEN NEW.status = 'running' AND EXISTS (
    SELECT 1
      FROM task_dependencies dependency
      JOIN tasks blocker ON blocker.id = dependency.blocker_task_id
     WHERE dependency.blocked_task_id = NEW.task_id
       AND blocker.status <> 'completed'
  ) THEN RAISE(ABORT, 'task_binding_invalid: unresolved dependency') END;
END;

CREATE TRIGGER trg_agent_runs_task_update
BEFORE UPDATE OF task_id, session_id, status ON agent_runs
WHEN NEW.task_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM tasks task
     WHERE task.id = NEW.task_id
       AND task.session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'task_binding_invalid: task unavailable') END;

  SELECT CASE WHEN NEW.status = 'running' AND EXISTS (
    SELECT 1 FROM tasks task
     WHERE task.id = NEW.task_id
       AND task.status NOT IN ('pending', 'in_progress')
  ) THEN RAISE(ABORT, 'task_binding_invalid: task unavailable') END;

  SELECT CASE WHEN NEW.status = 'running' AND EXISTS (
    SELECT 1
      FROM task_dependencies dependency
      JOIN tasks blocker ON blocker.id = dependency.blocker_task_id
     WHERE dependency.blocked_task_id = NEW.task_id
       AND blocker.status <> 'completed'
  ) THEN RAISE(ABORT, 'task_binding_invalid: unresolved dependency') END;
END;
