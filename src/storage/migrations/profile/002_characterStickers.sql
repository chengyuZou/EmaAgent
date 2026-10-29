CREATE TABLE character_stickers (
  character_name TEXT NOT NULL REFERENCES characters(name) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(character_name, name)
);

CREATE INDEX idx_character_stickers_order
  ON character_stickers(character_name, created_at, name);
