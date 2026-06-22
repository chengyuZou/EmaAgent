-- profile migration 002: replace old inline-body skills table with file-backed schema.
--
-- The old schema stored skill body text inline (no dir_path, no file backing).
-- The new schema is a filesystem index: source of truth is <dir_path>/SKILL.md,
-- this table is a frontmatter cache rebuilt at startup by SkillStore.scanAndReconcile.
--
-- Drop + recreate is safe — skills have no foreign-key dependants and the body
-- can be re-read from disk. Provider configs, bindings, memory, and cards are
-- in the same profile.db and are NOT touched.

DROP TABLE IF EXISTS skills;

CREATE TABLE skills (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,        -- frontmatter.name (logical id)
  version        TEXT NOT NULL DEFAULT '1.0.0',
  description    TEXT NOT NULL DEFAULT '',
  arg_hint       TEXT,                          -- frontmatter argument-hint (catalog display)
  dir_path       TEXT NOT NULL,                 -- absolute path to the skill directory
  source         TEXT NOT NULL DEFAULT 'user',  -- 'builtin' | 'user' | 'market'
  source_url     TEXT,                          -- market/github origin (optional)
  sha256         TEXT,                          -- market install integrity (optional)
  size_bytes     INTEGER NOT NULL DEFAULT 0,    -- total size of the skill dir (SKILL.md + assets)
  enabled        INTEGER NOT NULL DEFAULT 1,
  content_mtime  INTEGER NOT NULL DEFAULT 0,    -- SKILL.md mtime — detect external edits
  installed_at   INTEGER NOT NULL
);
