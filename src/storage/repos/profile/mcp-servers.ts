import type { SqliteDb } from '../../database/database.js';

// ── 原始 DB 行 ────────────────────────────────────────────────────────────────

export interface McpServerRow {
  id:           string;
  name:         string;
  install_source: 'manual' | 'import' | 'official';
  market_entry_id: string | null;
  config_json:  string;        // 原始 McpServerConfig JSON,由 mcp 包解析;
  tools_cache:  string | null; // 上次成功 listTools 返回的 JSON McpToolInfo[]
  enabled:      number;        // 0 | 1
  installed_at: number;
}

// ── McpServersRepo ─────────────────────────────────────────────────────────────
//
// 纯 SQL,不 import @ema-agent/mcp(避免循环依赖)。
// config_json 以原始字符串存取,结构校验与凭据加解密都在 src/mcp 的 McpServerStore。

export class McpServersRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(row: McpServerRow): void {
    this.db.prepare(`
      INSERT INTO mcp_servers (
        id, name, install_source, market_entry_id,
        config_json, tools_cache, enabled, installed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.name, row.install_source, row.market_entry_id,
      row.config_json,
      row.tools_cache, row.enabled, row.installed_at,
    );
  }

  update(id: string, patch: {
    name?:        string;
    installSource?: 'manual' | 'import' | 'official';
    marketEntryId?: string | null;
    configJson?:  string;
    toolsCache?:  string | null;
    enabled?:     number;
  }): void {
    const cols:   string[] = [];
    const values: unknown[] = [];

    if (patch.name       !== undefined) { cols.push('name = ?');        values.push(patch.name); }
    if (patch.installSource !== undefined) { cols.push('install_source = ?'); values.push(patch.installSource); }
    if (patch.marketEntryId !== undefined) { cols.push('market_entry_id = ?'); values.push(patch.marketEntryId); }
    if (patch.configJson !== undefined) { cols.push('config_json = ?'); values.push(patch.configJson); }
    if (patch.toolsCache !== undefined) { cols.push('tools_cache = ?'); values.push(patch.toolsCache); }
    if (patch.enabled    !== undefined) { cols.push('enabled = ?');     values.push(patch.enabled); }

    if (cols.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE mcp_servers SET ${cols.join(', ')} WHERE id = ?`).run(...values);
  }

  findById(id: string): McpServerRow | null {
    return (this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined) ?? null;
  }

  findByName(name: string): McpServerRow | null {
    return (this.db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name) as McpServerRow | undefined) ?? null;
  }

  listAll(): McpServerRow[] {
    return this.db.prepare('SELECT * FROM mcp_servers ORDER BY installed_at ASC').all() as McpServerRow[];
  }

  listEnabled(): McpServerRow[] {
    return this.db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY installed_at ASC').all() as McpServerRow[];
  }

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  }
}
