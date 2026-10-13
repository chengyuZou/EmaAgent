-- 一个 Turn 可以保存多个角色版本, 文件路径确定需要替换的那一份音频.
-- 只保留完整 WAV 记录. 不完整或非 WAV 的开发数据需先备份并明确清理,
-- 迁移本身不静默丢弃这些记录.
CREATE TABLE speech_outputs_new (
  turn_id       TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  storage_path  TEXT NOT NULL PRIMARY KEY,
  mime_type     TEXT NOT NULL CHECK(mime_type = 'audio/wav'),
  byte_size     INTEGER NOT NULL CHECK(byte_size >= 0),
  duration_ms   INTEGER NOT NULL CHECK(duration_ms >= 0),
  created_at    INTEGER NOT NULL
);

INSERT INTO speech_outputs_new (
  turn_id, session_id, storage_path, mime_type,
  byte_size, duration_ms, created_at
)
SELECT
  turn_id, session_id, storage_path, mime_type,
  byte_size, duration_ms, created_at
FROM speech_outputs;

DROP TABLE speech_outputs;
ALTER TABLE speech_outputs_new RENAME TO speech_outputs;

CREATE INDEX idx_speech_outputs_session ON speech_outputs(session_id, created_at DESC);
CREATE INDEX idx_speech_outputs_turn ON speech_outputs(turn_id);

CREATE TRIGGER trg_speech_outputs_owner_insert
BEFORE INSERT ON speech_outputs
WHEN NOT EXISTS (
  SELECT 1 FROM turns t
   WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: speech_outputs.turn_id');
END;

CREATE TRIGGER trg_speech_outputs_owner_update
BEFORE UPDATE OF session_id, turn_id ON speech_outputs
BEGIN
  SELECT CASE
    WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: speech_outputs.session_id is immutable')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM turns t
       WHERE t.id = NEW.turn_id AND t.session_id = NEW.session_id
    ) THEN RAISE(ABORT, 'ownership_violation: speech_outputs.turn_id')
  END;
END;
