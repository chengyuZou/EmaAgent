// mcp_registry_sources 的 SQL 层:官方 Registry 与兼容镜像端点,纯持久化不含业务。
import type { SqliteDb } from '../../database/database.js';

export interface McpRegistrySourceRow {
  id:           string;
  label:        string;
  registry_url: string;
  enabled:      number;          // 0 | 1
  builtin:      number;          // 0 | 1
  sort_order:   number;
  created_at:   number;
  updated_at:   number;
}

export type McpRegistrySourceInsert = Pick<
  McpRegistrySourceRow,
  'id' | 'label' | 'registry_url' | 'builtin' | 'sort_order' | 'created_at' | 'updated_at'
> & { enabled?: number };

export class McpRegistrySourcesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(row: McpRegistrySourceInsert): void {
    this.db.prepare(`
      INSERT INTO mcp_registry_sources
        (id, label, registry_url, enabled, builtin, sort_order, created_at, updated_at)
      VALUES
        (@id, @label, @registry_url, @enabled, @builtin, @sort_order, @created_at, @updated_at)
    `).run({ enabled: 1, ...row });
  }

  update(id: string, patch: Partial<Omit<McpRegistrySourceRow, 'id' | 'created_at' | 'builtin'>>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const cols = entries.map(([key]) => `${key} = @${key}`).join(', ');
    this.db.prepare(`UPDATE mcp_registry_sources SET ${cols} WHERE id = @__id`)
      .run({ ...Object.fromEntries(entries), __id: id });
  }

  findById(id: string): McpRegistrySourceRow | null {
    return (this.db.prepare('SELECT * FROM mcp_registry_sources WHERE id = ?').get(id) as McpRegistrySourceRow | undefined) ?? null;
  }

  listAll(): McpRegistrySourceRow[] {
    return this.db.prepare(
      'SELECT * FROM mcp_registry_sources ORDER BY sort_order ASC, created_at ASC',
    ).all() as McpRegistrySourceRow[];
  }

  listEnabled(): McpRegistrySourceRow[] {
    return this.db.prepare(
      'SELECT * FROM mcp_registry_sources WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC',
    ).all() as McpRegistrySourceRow[];
  }

  /** 内置源(官方 Registry)不可删,只可禁用。 */
  deleteById(id: string): boolean {
    return this.db.prepare('DELETE FROM mcp_registry_sources WHERE id = ? AND builtin = 0').run(id).changes === 1;
  }
}
