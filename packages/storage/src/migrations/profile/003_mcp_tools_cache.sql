-- 003: add tools_cache + cached_at to mcp_servers.
-- These columns were originally only present in an edited 001_initial.sql, so
-- databases created before the edit lack them. Moving them here keeps both
-- fresh and existing DBs consistent (001 no longer declares them).
ALTER TABLE mcp_servers ADD COLUMN tools_cache TEXT;
ALTER TABLE mcp_servers ADD COLUMN cached_at   INTEGER NOT NULL DEFAULT 0;
