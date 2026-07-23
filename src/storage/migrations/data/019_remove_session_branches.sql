-- Session 历史收敛为线性 Turn；历史分叉统一创建独立 Session。

DROP TRIGGER IF EXISTS trg_sessions_owner_insert;
DROP TRIGGER IF EXISTS trg_sessions_owner_update;
DROP TRIGGER IF EXISTS trg_branches_owner_insert;
DROP TRIGGER IF EXISTS trg_branches_owner_update;
DROP TRIGGER IF EXISTS trg_turns_owner_insert;
DROP TRIGGER IF EXISTS trg_turns_owner_update;

DROP INDEX IF EXISTS idx_turns_branch;
DROP INDEX IF EXISTS idx_branches_session;
DROP INDEX IF EXISTS idx_branches_fork_turn;

ALTER TABLE sessions DROP COLUMN active_branch_id;
ALTER TABLE turns DROP COLUMN branch_id;
DROP TABLE branches;

CREATE TRIGGER trg_sessions_owner_update
BEFORE UPDATE OF id ON sessions
WHEN NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: sessions.id is immutable');
END;

CREATE TRIGGER trg_turns_owner_update
BEFORE UPDATE OF session_id ON turns
WHEN NEW.session_id <> OLD.session_id
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: turns.session_id is immutable');
END;
