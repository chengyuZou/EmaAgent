import type { SqliteDb } from '../database.js';

// ── Raw DB row ────────────────────────────────────────────────────────────────

export interface McpServerRow {
  id:           string;
  name:         string;
  source_url:   string | null;
  config_json:  string;        // raw McpServerConfig JSON — parsed by mcp package
  tools_cache:  string | null; // JSON McpToolInfo[] from last successful listTools
  cached_at:    number;        // ms; 0 = never cached
  enabled:      number;        // 0 | 1
  installed_at: number;
}

// ── McpServersRepo ─────────────────────────────────────────────────────────────
//
// Pure SQL — does NOT import from @ema-agent/mcp (avoids circular deps).
// config_json is stored and returned as a raw string; schema validation
// lives in McpServerStore in packages/mcp.

export class McpServersRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(row: McpServerRow): void {
    this.db.prepare(`
      INSERT INTO mcp_servers (id, name, source_url, config_json, tools_cache, cached_at, enabled, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.name, row.source_url, row.config_json,
      row.tools_cache, row.cached_at, row.enabled, row.installed_at,
    );
  }

  update(id: string, patch: {
    name?:        string;
    sourceUrl?:   string | null;
    configJson?:  string;
    toolsCache?:  string | null;
    cachedAt?:    number;
    enabled?:     number;
  }): void {
    const cols:   string[] = [];
    const values: unknown[] = [];

    if (patch.name       !== undefined) { cols.push('name = ?');        values.push(patch.name); }
    if (patch.sourceUrl  !== undefined) { cols.push('source_url = ?');  values.push(patch.sourceUrl); }
    if (patch.configJson !== undefined) { cols.push('config_json = ?'); values.push(patch.configJson); }
    if (patch.toolsCache !== undefined) { cols.push('tools_cache = ?'); values.push(patch.toolsCache); }
    if (patch.cachedAt   !== undefined) { cols.push('cached_at = ?');   values.push(patch.cachedAt); }
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
