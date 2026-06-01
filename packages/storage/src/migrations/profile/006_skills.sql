-- Skills: A+B prompt-injection plugins
-- content_md stores the full raw SKILL.md (frontmatter + body).
-- Parsed by SkillStore in packages/skill — storage layer stays schema-agnostic.

CREATE TABLE skills (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  version        TEXT NOT NULL DEFAULT '1.0.0',
  description    TEXT NOT NULL DEFAULT '',
  source_url     TEXT,
  content_md     TEXT NOT NULL,
  activates_json TEXT NOT NULL DEFAULT '["agent"]',
  enabled        INTEGER NOT NULL DEFAULT 1,
  installed_at   INTEGER NOT NULL
);
