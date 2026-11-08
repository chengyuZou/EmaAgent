ALTER TABLE speech_outputs RENAME TO speech_outputs_legacy;

CREATE TABLE speech_outputs (
  audio_id      TEXT NOT NULL PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id       TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  character_name TEXT NOT NULL,
  storage_path  TEXT NOT NULL UNIQUE,
  mime_type     TEXT NOT NULL CHECK(mime_type = 'audio/wav'),
  audio_status  TEXT NOT NULL CHECK(audio_status IN ('generating', 'ready', 'deleting', 'failed')),
  byte_size     INTEGER CHECK(byte_size >= 0),
  duration_ms   INTEGER CHECK(duration_ms >= 0),
  created_at    INTEGER NOT NULL,
  failure_message TEXT,
  CHECK(audio_status != 'ready' OR (byte_size IS NOT NULL AND duration_ms IS NOT NULL))
);

-- 旧 WAV 保留原路径和真实时长. 角色名只从旧版本约定的文件名提取, 不改动磁盘文件.
INSERT INTO speech_outputs (
  audio_id, session_id, turn_id, character_name, storage_path,
  mime_type, audio_status, byte_size, duration_ms, created_at, failure_message
)
SELECT lower(hex(randomblob(16))), session_id, turn_id,
  CASE WHEN instr(replace(storage_path, char(92), '/'), '/' || turn_id || '-') > 0
    THEN substr(
      replace(storage_path, char(92), '/'),
      instr(replace(storage_path, char(92), '/'), '/' || turn_id || '-') + length(turn_id) + 2,
      length(storage_path) - instr(replace(storage_path, char(92), '/'), '/' || turn_id || '-') - length(turn_id) - 5
    )
    ELSE ''
  END,
  storage_path, mime_type, 'ready', byte_size, duration_ms, created_at, NULL
FROM speech_outputs_legacy;

DROP TABLE speech_outputs_legacy;

CREATE INDEX idx_speech_outputs_session ON speech_outputs(session_id, created_at DESC);
CREATE INDEX idx_speech_outputs_turn_character ON speech_outputs(turn_id, character_name, created_at DESC);

CREATE TRIGGER trg_speech_outputs_owner_insert
BEFORE INSERT ON speech_outputs
WHEN NOT EXISTS (
  SELECT 1 FROM turns WHERE id = NEW.turn_id AND session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'ownership_violation: speech_outputs.turn_id');
END;

CREATE TRIGGER trg_speech_outputs_owner_update
BEFORE UPDATE OF session_id, turn_id ON speech_outputs
BEGIN
  SELECT CASE WHEN NEW.session_id <> OLD.session_id
    THEN RAISE(ABORT, 'ownership_violation: speech_outputs.session_id is immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM turns WHERE id = NEW.turn_id AND session_id = NEW.session_id
  ) THEN RAISE(ABORT, 'ownership_violation: speech_outputs.turn_id') END;
END;

CREATE TABLE speech_output_segments (
  audio_id      TEXT NOT NULL REFERENCES speech_outputs(audio_id) ON DELETE CASCADE,
  segment_index INTEGER NOT NULL CHECK(segment_index >= 0),
  text_for_tts  TEXT NOT NULL,
  start_ms      REAL NOT NULL CHECK(start_ms >= 0),
  end_ms        REAL NOT NULL CHECK(end_ms > start_ms),
  PRIMARY KEY (audio_id, segment_index)
);
