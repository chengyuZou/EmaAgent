ALTER TABLE mcp_servers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'oauth'));

CREATE TABLE mcp_oauth_credentials (
  mcp_server_id TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
  server_url TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_mcp_oauth_credentials_server_url
  ON mcp_oauth_credentials(server_url);
