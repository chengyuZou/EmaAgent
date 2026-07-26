-- 为图片 Vision 派生结果建立可回收的内容寻址缓存；它不是 Session 附件事实源。

CREATE TABLE attachment_cached_images (
  content_sha256 TEXT PRIMARY KEY
    CHECK(length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  relative_path TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL CHECK(mime IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  width INTEGER NOT NULL CHECK(width > 0),
  height INTEGER NOT NULL CHECK(height > 0),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE attachment_vision_derivations (
  id TEXT PRIMARY KEY,
  content_sha256 TEXT NOT NULL
    REFERENCES attachment_cached_images(content_sha256) ON DELETE CASCADE,
  task TEXT NOT NULL CHECK(task IN ('auto', 'caption', 'ocr', 'layout', 'table')),
  provider_config_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL
    CHECK(length(prompt_sha256) = 64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'),
  transform_version TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  relative_path TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  UNIQUE (
    content_sha256,
    task,
    provider_config_id,
    model_id,
    prompt_sha256,
    transform_version,
    language
  )
);

CREATE INDEX idx_attachment_cached_images_lru
  ON attachment_cached_images(last_used_at ASC, content_sha256 ASC);

CREATE INDEX idx_attachment_vision_derivations_lru
  ON attachment_vision_derivations(last_used_at ASC, id ASC);
