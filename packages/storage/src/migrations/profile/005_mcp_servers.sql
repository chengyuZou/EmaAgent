-- MCP server configurations (global — shared across all data dirs)
-- config_json holds the raw transport config (stdio / sse / http union).
-- Env vars with placeholder values (e.g. API keys) are stored as-is;
-- the UI prompts the user to fill them during installation.

CREATE TABLE mcp_servers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,   -- user-facing alias, also used as the qualified tool prefix
  source_url   TEXT,                   -- mcp.so page URL (optional, informational)
  config_json  TEXT NOT NULL,          -- McpServerConfig JSON
  enabled      INTEGER NOT NULL DEFAULT 1,
  installed_at INTEGER NOT NULL
);
