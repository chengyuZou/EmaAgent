-- MCP 市场安装保存明确来源和包版本，避免配置变化后仍错误声称已锁定。
ALTER TABLE mcp_servers ADD COLUMN install_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (install_source IN ('manual', 'import', 'market'));
ALTER TABLE mcp_servers ADD COLUMN market_source_id TEXT;
ALTER TABLE mcp_servers ADD COLUMN market_source_type TEXT;
ALTER TABLE mcp_servers ADD COLUMN package_registry TEXT;
ALTER TABLE mcp_servers ADD COLUMN package_name TEXT;
ALTER TABLE mcp_servers ADD COLUMN package_version TEXT;
ALTER TABLE mcp_servers ADD COLUMN package_integrity TEXT;
