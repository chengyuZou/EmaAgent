-- B-005：阻止同一行中的 session_id 与 turn/branch/message/task 引用跨 Session 串联。
--
-- SQLite 无法在不重建整张表的情况下追加复合外键；而 data schema 存在
-- sessions <-> branches <-> turns 循环引用以及 messages FTS5 投影。这里使用
-- 数据库 BEFORE trigger 实现等价的 ownership 约束，保留既有单列 FK 的
-- CASCADE / SET NULL 语义，并避免一次迁移重建整个 data schema。

-- 升级前先检查历史数据。发现任何跨 Session 引用时立即中止整个迁移，
-- 不自动删除或修正用户数据，user_version 也会保持在旧版本。
CREATE TEMP TABLE _b005_ownership_guard (marker INTEGER NOT NULL);
CREATE TEMP TRIGGER _b005_abort_on_existing_violation
BEFORE INSERT ON _b005_ownership_guard
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: existing cross-session reference');
END;

INSERT INTO _b005_ownership_guard(marker)
SELECT 1
WHERE EXISTS (
  SELECT 1 FROM sessions s
   WHERE s.active_branch_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM branches b
        WHERE b.id = s.active_branch_id AND b.session_id = s.id
     )
  UNION ALL
  SELECT 1 FROM branches b
   WHERE b.parent_branch_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM branches p
        WHERE p.id = b.parent_branch_id AND p.session_id = b.session_id
     )
  UNION ALL
  SELECT 1 FROM branches b
   WHERE b.fork_from_turn_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM turns t
        WHERE t.id = b.fork_from_turn_id AND t.session_id = b.session_id
     )
  UNION ALL
  SELECT 1 FROM turns t
   WHERE t.branch_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM branches b
        WHERE b.id = t.branch_id AND b.session_id = t.session_id
     )
  UNION ALL
  SELECT 1 FROM messages m
   WHERE m.turn_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM turns t
        WHERE t.id = m.turn_id AND t.session_id = m.session_id
     )
  UNION ALL
  SELECT 1 FROM pending_fragments p
   WHERE NOT EXISTS (
     SELECT 1 FROM turns t
      WHERE t.id = p.turn_id AND t.session_id = p.session_id
   )
  UNION ALL
  SELECT 1 FROM session_notes n
   WHERE n.last_message_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM messages m
        WHERE m.id = n.last_message_id AND m.session_id = n.session_id
     )
  UNION ALL
  SELECT 1 FROM turn_audio_segments a
   WHERE NOT EXISTS (
     SELECT 1 FROM turns t
      WHERE t.id = a.turn_id AND t.session_id = a.session_id
   )
  UNION ALL
  SELECT 1 FROM turn_audio_merged a
   WHERE NOT EXISTS (
     SELECT 1 FROM turns t
      WHERE t.id = a.turn_id AND t.session_id = a.session_id
   )
  UNION ALL
  SELECT 1 FROM turn_attachments a
   WHERE NOT EXISTS (
     SELECT 1 FROM turns t
      WHERE t.id = a.turn_id AND t.session_id = a.session_id
   )
  UNION ALL
  SELECT 1 FROM artifacts a
   WHERE a.turn_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM turns t
        WHERE t.id = a.turn_id AND t.session_id = a.session_id
     )
  UNION ALL
  SELECT 1 FROM agent_tasks a
   WHERE a.turn_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM turns t
        WHERE t.id = a.turn_id AND t.session_id = a.session_id
     )
  UNION ALL
  SELECT 1 FROM agent_tasks a
   WHERE a.parent_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM agent_tasks p
        WHERE p.id = a.parent_id AND p.session_id = a.session_id
     )
  UNION ALL
  SELECT 1 FROM kb_activations k
   WHERE k.turn_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM turns t
        WHERE t.id = k.turn_id AND t.session_id = k.session_id
     )
  LIMIT 1
);

DROP TRIGGER _b005_abort_on_existing_violation;
DROP TABLE _b005_ownership_guard;

-- Session.active_branch_id -> Branch(session)。
CREATE TRIGGER trg_sessions_owner_insert
BEFORE INSERT ON sessions
WHEN NEW.active_branch_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM branches b
    WHERE b.id = NEW.active_branch_id AND b.session_id = NEW.id
 )
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: sessions.active_branch_id');
END;

CREATE TRIGGER trg_sessions_owner_update
BEFORE UPDATE OF id, active_branch_id ON sessions
BEGIN
  SELECT CASE
    WHEN NEW.id <> OLD.id
    THEN RAISE(ABORT, 'ownership_violation: sessions.id is immutable')
  END;
  SELECT CASE
    WHEN NEW.active_branch_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM branches b
       WHERE b.id = NEW.active_branch_id AND b.session_id = NEW.id
    ) THEN RAISE(ABORT, 'ownership_violation: sessions.active_branch_id')
  END;
END;

-- Branch.parent_branch_id / fork_from_turn_id -> 同 Session 的 Branch / Turn。
CREATE TRIGGER trg_branches_owner_insert
BEFORE INSERT ON branches
BEGIN
  SELECT CASE
    WHEN NEW.parent_branch_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM branches p
       WHERE p.id = NEW.parent_branch_id AND p.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: branches.parent_branch_id')
  END;
  SELECT CASE
    WHEN NEW.fork_from_turn_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.fork_from_turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: branches.fork_from_turn_id')
  END;
END;

CREATE TRIGGER trg_branches_owner_update
BEFORE UPDATE OF session_id, parent_branch_id, fork_from_turn_id ON branches
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: branches.session_id is immutable')
  END;
  SELECT CASE
    WHEN NEW.parent_branch_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM branches p
       WHERE p.id = NEW.parent_branch_id AND p.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: branches.parent_branch_id')
  END;
  SELECT CASE
    WHEN NEW.fork_from_turn_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.fork_from_turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: branches.fork_from_turn_id')
  END;
END;

-- Turn.branch_id -> 同 Session 的 Branch。
CREATE TRIGGER trg_turns_owner_insert
BEFORE INSERT ON turns
WHEN NEW.branch_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM branches b
    WHERE b.id = NEW.branch_id AND b.session_id = NEW.session_id
 )
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: turns.branch_id');
END;

CREATE TRIGGER trg_turns_owner_update
BEFORE UPDATE OF session_id, branch_id ON turns
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: turns.session_id is immutable')
  END;
  SELECT CASE
    WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM branches b
       WHERE b.id = NEW.branch_id AND b.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: turns.branch_id')
  END;
END;

-- agent_tasks / kb_activations 的 turn_id 历史上没有单列 FK。
-- Turn 删除时显式清空裸引用，避免删除动作制造新的悬空 ownership。
CREATE TRIGGER trg_turns_owner_delete_cleanup
AFTER DELETE ON turns
BEGIN
  UPDATE agent_tasks
     SET turn_id = NULL
   WHERE turn_id = OLD.id AND session_id = OLD.session_id;
  UPDATE kb_activations
     SET turn_id = NULL
   WHERE turn_id = OLD.id AND session_id = OLD.session_id;
END;

-- 以下表的 turn_id / message_id 都必须属于行内 session_id。
CREATE TRIGGER trg_messages_owner_insert
BEFORE INSERT ON messages
WHEN NEW.turn_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM turns t
    WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
 )
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: messages.turn_id');
END;

CREATE TRIGGER trg_messages_owner_update
BEFORE UPDATE OF session_id, turn_id ON messages
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: messages.session_id is immutable')
  END;
  SELECT CASE
    WHEN NEW.turn_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: messages.turn_id')
  END;
END;

-- Session note 的 last_message_id 是提取水位，不应在 Message 删除后悬空。
CREATE TRIGGER trg_messages_owner_delete_cleanup
AFTER DELETE ON messages
BEGIN
  UPDATE session_notes
     SET last_message_id = NULL
   WHERE last_message_id = OLD.id AND session_id = OLD.session_id;
END;

CREATE TRIGGER trg_pending_fragments_owner_insert
BEFORE INSERT ON pending_fragments
WHEN NOT EXISTS (
  SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: pending_fragments.turn_id');
END;

CREATE TRIGGER trg_pending_fragments_owner_update
BEFORE UPDATE OF session_id, turn_id ON pending_fragments
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: pending_fragments.session_id is immutable')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: pending_fragments.turn_id')
  END;
END;

CREATE TRIGGER trg_session_notes_owner_insert
BEFORE INSERT ON session_notes
WHEN NEW.last_message_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM messages m
    WHERE m.id = NEW.last_message_id AND m.session_id = NEW.session_id
 )
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: session_notes.last_message_id');
END;

CREATE TRIGGER trg_session_notes_owner_update
BEFORE UPDATE OF session_id, last_message_id ON session_notes
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: session_notes.session_id is immutable')
  END;
  SELECT CASE
    WHEN NEW.last_message_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM messages m
       WHERE m.id = NEW.last_message_id AND m.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: session_notes.last_message_id')
  END;
END;

CREATE TRIGGER trg_audio_segments_owner_insert
BEFORE INSERT ON turn_audio_segments
WHEN NOT EXISTS (
  SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: turn_audio_segments.turn_id');
END;

CREATE TRIGGER trg_audio_segments_owner_update
BEFORE UPDATE OF session_id, turn_id ON turn_audio_segments
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: turn_audio_segments.session_id is immutable')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: turn_audio_segments.turn_id')
  END;
END;

CREATE TRIGGER trg_audio_merged_owner_insert
BEFORE INSERT ON turn_audio_merged
WHEN NOT EXISTS (
  SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: turn_audio_merged.turn_id');
END;

CREATE TRIGGER trg_audio_merged_owner_update
BEFORE UPDATE OF session_id, turn_id ON turn_audio_merged
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: turn_audio_merged.session_id is immutable')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: turn_audio_merged.turn_id')
  END;
END;

CREATE TRIGGER trg_attachments_owner_insert
BEFORE INSERT ON turn_attachments
WHEN NOT EXISTS (
  SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: turn_attachments.turn_id');
END;

CREATE TRIGGER trg_attachments_owner_update
BEFORE UPDATE OF session_id, turn_id ON turn_attachments
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: turn_attachments.session_id is immutable')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: turn_attachments.turn_id')
  END;
END;

CREATE TRIGGER trg_artifacts_owner_insert
BEFORE INSERT ON artifacts
WHEN NEW.turn_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM turns t
    WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
 )
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: artifacts.turn_id');
END;

CREATE TRIGGER trg_artifacts_owner_update
BEFORE UPDATE OF session_id, turn_id ON artifacts
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: artifacts.session_id is immutable')
  END;
  SELECT CASE
    WHEN NEW.turn_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: artifacts.turn_id')
  END;
END;

-- AgentTask.turn_id / parent_id -> 同 Session 的 Turn / AgentTask。
CREATE TRIGGER trg_agent_tasks_owner_insert
BEFORE INSERT ON agent_tasks
BEGIN
  SELECT CASE
    WHEN NEW.turn_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: agent_tasks.turn_id')
  END;
  SELECT CASE
    WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM agent_tasks p
       WHERE p.id = NEW.parent_id AND p.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: agent_tasks.parent_id')
  END;
END;

CREATE TRIGGER trg_agent_tasks_owner_update
BEFORE UPDATE OF session_id, turn_id, parent_id ON agent_tasks
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: agent_tasks.session_id is immutable')
  END;
  SELECT CASE
    WHEN NEW.turn_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: agent_tasks.turn_id')
  END;
  SELECT CASE
    WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM agent_tasks p
       WHERE p.id = NEW.parent_id AND p.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: agent_tasks.parent_id')
  END;
END;

-- parent_id 没有历史单列 FK；删除父任务时保留子任务记录并清空父引用。
CREATE TRIGGER trg_agent_tasks_owner_delete_cleanup
AFTER DELETE ON agent_tasks
BEGIN
  UPDATE agent_tasks
     SET parent_id = NULL
   WHERE parent_id = OLD.id AND session_id = OLD.session_id;
END;

-- KB 的 kb_id / asset_id 跨库无法建 FK，但 turn_id 位于同一 data.db，可校验 ownership。
CREATE TRIGGER trg_kb_activations_owner_insert
BEFORE INSERT ON kb_activations
WHEN NEW.turn_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM turns t
    WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
 )
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: kb_activations.turn_id');
END;

CREATE TRIGGER trg_kb_activations_owner_update
BEFORE UPDATE OF session_id, turn_id ON kb_activations
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: kb_activations.session_id is immutable')
  END;
  SELECT CASE
    WHEN NEW.turn_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: kb_activations.turn_id')
  END;
END;
