-- 将角色表现资源从单值字段和 JSON 拆成可约束、可排序、可独立管理的显式记录。
-- ema:migration foreign_keys=off

ALTER TABLE character_cards RENAME TO character_cards_legacy;
DROP INDEX idx_character_cards_active;

CREATE TABLE character_cards (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  version               TEXT NOT NULL DEFAULT 'v1.0.0',
  description           TEXT,
  system_prompt         TEXT NOT NULL,
  speech_patterns_json  TEXT NOT NULL DEFAULT '[]',
  forbidden_topics_json TEXT NOT NULL DEFAULT '[]',
  emotion_vocab_json    TEXT NOT NULL DEFAULT '[]',
  motion_vocab_json     TEXT NOT NULL DEFAULT '[]',
  is_active             INTEGER NOT NULL DEFAULT 0,
  is_builtin            INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

INSERT INTO character_cards (
  id, name, version, description, system_prompt,
  speech_patterns_json, forbidden_topics_json,
  emotion_vocab_json, motion_vocab_json,
  is_active, is_builtin, created_at, updated_at
)
SELECT
  id, name, version, description, system_prompt,
  speech_patterns_json, forbidden_topics_json,
  emotion_vocab_json, motion_vocab_json,
  is_active, is_builtin, created_at, updated_at
FROM character_cards_legacy;

CREATE UNIQUE INDEX idx_character_cards_active
  ON character_cards(is_active)
  WHERE is_active = 1;

CREATE TABLE character_live2d_variants (
  id                  TEXT PRIMARY KEY,
  character_card_id   TEXT NOT NULL REFERENCES character_cards(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  format              TEXT NOT NULL CHECK(format IN ('live2d','vrm')),
  entry_path          TEXT NOT NULL COLLATE NOCASE,
  runtime_config_path TEXT COLLATE NOCASE,
  position            INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  is_primary          INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  resource_version    TEXT,
  content_sha256      TEXT,
  byte_size           INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  is_builtin          INTEGER NOT NULL DEFAULT 0 CHECK(is_builtin IN (0,1)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(character_card_id, entry_path)
);

CREATE UNIQUE INDEX idx_character_live2d_primary
  ON character_live2d_variants(character_card_id)
  WHERE is_primary = 1;

CREATE INDEX idx_character_live2d_order
  ON character_live2d_variants(character_card_id, position ASC, id ASC);

CREATE TABLE character_portraits (
  id                TEXT PRIMARY KEY,
  character_card_id TEXT NOT NULL REFERENCES character_cards(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  relative_path     TEXT NOT NULL COLLATE NOCASE,
  position          INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  mime_type         TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
  byte_size         INTEGER NOT NULL CHECK(byte_size >= 0),
  width             INTEGER NOT NULL CHECK(width > 0),
  height            INTEGER NOT NULL CHECK(height > 0),
  content_sha256    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(character_card_id, relative_path)
);

CREATE UNIQUE INDEX idx_character_portraits_primary
  ON character_portraits(character_card_id)
  WHERE is_primary = 1;

CREATE INDEX idx_character_portraits_order
  ON character_portraits(character_card_id, position ASC, id ASC);

CREATE TABLE character_voice_references (
  id                TEXT PRIMARY KEY,
  character_card_id TEXT NOT NULL REFERENCES character_cards(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  relative_path     TEXT NOT NULL COLLATE NOCASE,
  prompt_text       TEXT NOT NULL,
  prompt_lang       TEXT NOT NULL,
  position          INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  mime_type         TEXT NOT NULL,
  byte_size         INTEGER CHECK(byte_size IS NULL OR byte_size >= 0),
  duration_ms       INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  content_sha256    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(character_card_id, relative_path)
);

CREATE UNIQUE INDEX idx_character_voice_primary
  ON character_voice_references(character_card_id)
  WHERE is_primary = 1;

CREATE INDEX idx_character_voice_order
  ON character_voice_references(character_card_id, position ASC, id ASC);

-- 旧单模型自动成为主变体。entry_path 统一为角色目录内相对路径。
INSERT INTO character_live2d_variants (
  id, character_card_id, label, format, entry_path, runtime_config_path,
  position, is_primary, enabled, resource_version, content_sha256,
  byte_size, is_builtin, created_at, updated_at
)
SELECT
  card.id || ':' || model.id,
  card.id,
  model.name,
  model.format,
  CASE
    WHEN model.storage_path LIKE 'cards/' || card.id || '/%'
      THEN substr(model.storage_path, length('cards/' || card.id || '/') + 1)
    ELSE model.storage_path
  END,
  CASE
    WHEN model.format = 'live2d' THEN 'live2d/runtime-config.json'
    ELSE NULL
  END,
  0,
  1,
  1,
  NULL,
  NULL,
  NULL,
  model.is_builtin,
  model.created_at,
  model.updated_at
FROM character_cards_legacy AS card
JOIN live2d_models AS model ON model.id = card.live2d_model_id
WHERE card.live2d_model_id IS NOT NULL
  AND (
    model.storage_path LIKE 'cards/' || card.id || '/live2d/%'
    OR model.storage_path LIKE 'live2d/%'
  )
  AND model.storage_path NOT LIKE '%/../%'
  AND model.storage_path NOT LIKE '%/..'
  AND model.storage_path NOT LIKE '%\%';

-- 旧 JSON 只在迁移期解析一次，运行时不再保留第二套角色声音事实源。
INSERT INTO character_voice_references (
  id, character_card_id, label, relative_path, prompt_text, prompt_lang,
  position, is_primary, enabled, mime_type, byte_size, duration_ms,
  content_sha256, created_at, updated_at
)
SELECT
  card.id || ':' || json_extract(ref.value, '$.id') || ':' || CAST(ref.key AS TEXT),
  card.id,
  COALESCE(json_extract(ref.value, '$.label'), ''),
  json_extract(ref.value, '$.refAudioPath'),
  COALESCE(json_extract(ref.value, '$.promptText'), ''),
  COALESCE(json_extract(ref.value, '$.promptLang'), ''),
  CAST(ref.key AS INTEGER),
  0,
  1,
  CASE
    WHEN lower(json_extract(ref.value, '$.refAudioPath')) LIKE '%.mp3' THEN 'audio/mpeg'
    WHEN lower(json_extract(ref.value, '$.refAudioPath')) LIKE '%.wav' THEN 'audio/wav'
    WHEN lower(json_extract(ref.value, '$.refAudioPath')) LIKE '%.flac' THEN 'audio/flac'
    WHEN lower(json_extract(ref.value, '$.refAudioPath')) LIKE '%.ogg' THEN 'audio/ogg'
    WHEN lower(json_extract(ref.value, '$.refAudioPath')) LIKE '%.opus' THEN 'audio/ogg'
    WHEN lower(json_extract(ref.value, '$.refAudioPath')) LIKE '%.m4a' THEN 'audio/mp4'
    ELSE 'application/octet-stream'
  END,
  NULL,
  NULL,
  NULL,
  card.created_at,
  card.updated_at
FROM character_cards_legacy AS card,
json_each(
  CASE
    WHEN json_valid(card.voice_profile_json) THEN card.voice_profile_json
    ELSE '{"refAudios":[]}'
  END,
  '$.refAudios'
) AS ref
WHERE json_type(ref.value, '$.id') = 'text'
  AND json_type(ref.value, '$.refAudioPath') = 'text'
  AND json_extract(ref.value, '$.refAudioPath') NOT LIKE '/%'
  AND json_extract(ref.value, '$.refAudioPath') NOT LIKE '\%'
  AND json_extract(ref.value, '$.refAudioPath') NOT LIKE '%:/%'
  AND json_extract(ref.value, '$.refAudioPath') NOT LIKE '%:\%'
  AND json_extract(ref.value, '$.refAudioPath') NOT LIKE '../%'
  AND json_extract(ref.value, '$.refAudioPath') NOT LIKE '%/../%'
  AND json_extract(ref.value, '$.refAudioPath') NOT LIKE '..\%'
  AND json_extract(ref.value, '$.refAudioPath') NOT LIKE '%\..\%'
  AND json_extract(ref.value, '$.refAudioPath') GLOB 'voiceRefs/*'
  AND substr(
    json_extract(ref.value, '$.refAudioPath'),
    length('voiceRefs/') + 1
  ) <> ''
  AND instr(
    substr(
      json_extract(ref.value, '$.refAudioPath'),
      length('voiceRefs/') + 1
    ),
    '/'
  ) = 0
  AND instr(json_extract(ref.value, '$.refAudioPath'), '\') = 0;

-- 旧 primaryId 可能缺失、陈旧或重复；迁移后为每个有声音的角色确定性选第一条。
UPDATE character_voice_references
SET is_primary = 1
WHERE id IN (
  SELECT first_ref.id
  FROM character_voice_references AS first_ref
  WHERE first_ref.id = (
    SELECT candidate.id
    FROM character_voice_references AS candidate
    WHERE candidate.character_card_id = first_ref.character_card_id
    ORDER BY candidate.position ASC, candidate.id ASC
    LIMIT 1
  )
);

DROP TABLE live2d_models;
DROP TABLE character_cards_legacy;
