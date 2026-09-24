-- 子代理归 Session 所有；删除首次调用所在的 Turn 不应删除子代理及其消息。
DROP TRIGGER trg_subagents_owner_insert;
DROP TRIGGER trg_subagents_owner_update;
DROP INDEX idx_subagents_parent_turn;

ALTER TABLE subagents DROP COLUMN parent_turn_id;

CREATE TRIGGER trg_subagents_session_immutable
BEFORE UPDATE OF session_id ON subagents
WHEN NEW.session_id <> OLD.session_id
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: subagents.session_id is immutable');
END;
