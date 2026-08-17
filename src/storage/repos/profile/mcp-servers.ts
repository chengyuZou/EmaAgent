import type { SqliteDb } from '../../database/database.js';

// ── 原始 DB 行 ────────────────────────────────────────────────────────────────

export interface McpServerRow {
  id:           string;
  name:         string;
  source_url:   string | null;
  install_source: 'manual' | 'import' | 'registry';
  registry_source_id: string | null;
  registry_entry_id:  string | null;
  registry_version:   string | null;
  config_json:  string;        // 原始 McpServerConfig JSON,由 mcp 包解析;
  tools_cache:  string | null; // 上次成功 listTools 返回的 JSON McpToolInfo[]
  cached_at:    number;        // 毫秒;0 = 从未缓存
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
        id, name, source_url, install_source,
        registry_source_id, registry_entry_id, registry_version,
        config_json, tools_cache, cached_at, enabled, installed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.name, row.source_url, row.install_source,
      row.registry_source_id, row.registry_entry_id, row.registry_version,
      row.config_json,
      row.tools_cache, row.cached_at, row.enabled, row.installed_at,
    );
  }

  update(id: string, patch: {
    name?:        string;
    sourceUrl?:   string | null;
    installSource?: 'manual' | 'import' | 'registry';
    registrySourceId?: string | null;
    registryEntryId?:  string | null;
    registryVersion?:  string | null;
    configJson?:  string;
    toolsCache?:  string | null;
    cachedAt?:    number;
    enabled?:     number;
  }): void {
    const cols:   string[] = [];
    const values: unknown[] = [];

    if (patch.name       !== undefined) { cols.push('name = ?');        values.push(patch.name); }
    if (patch.sourceUrl  !== undefined) { cols.push('source_url = ?');  values.push(patch.sourceUrl); }
    if (patch.installSource !== undefined) { cols.push('install_source = ?'); values.push(patch.installSource); }
    if (patch.registrySourceId !== undefined) { cols.push('registry_source_id = ?'); values.push(patch.registrySourceId); }
    if (patch.registryEntryId  !== undefined) { cols.push('registry_entry_id = ?');  values.push(patch.registryEntryId); }
    if (patch.registryVersion  !== undefined) { cols.push('registry_version = ?');   values.push(patch.registryVersion); }
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
