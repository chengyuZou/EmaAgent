import type { SqliteDb } from '../../database/database.js';

export interface McpMarketEntryRow {
  source: string;
  external_id: string;
  name: string;
  description: string;
  repository_url: string | null;
  detail_url: string;
}

export interface McpMarketFetchStateRow {
  source: string;
  next_cursor: string | null;
}

export class McpMarketEntriesRepo {
  constructor(private readonly db: SqliteDb) {}

  replaceSource(source: string, rows: readonly McpMarketEntryRow[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM mcp_market_entries WHERE source = ?').run(source);
      const insert = this.entryUpsert();
      for (const row of rows) insert.run(row);
      this.saveFetchState(source, null);
    })();
  }

  appendPage(source: string, rows: readonly McpMarketEntryRow[], nextCursor: string | null): void {
    this.db.transaction(() => {
      const insert = this.entryUpsert();
      for (const row of rows) insert.run(row);
      this.saveFetchState(source, nextCursor);
    })();
  }

  fetchState(source: string): McpMarketFetchStateRow | null {
    return this.db.prepare(
      'SELECT source, next_cursor FROM mcp_market_fetch_state WHERE source = ?',
    ).get(source) as McpMarketFetchStateRow | undefined ?? null;
  }

  listPage(source: string, query: string, offset: number, pageSize: number): {
    rows: McpMarketEntryRow[];
    total: number;
  } {
    const normalized = query.trim().toLocaleLowerCase();
    const filter = normalized
      ? 'source = ? AND (instr(lower(name), ?) > 0 OR instr(lower(description), ?) > 0)'
      : 'source = ?';
    const params = normalized ? [source, normalized, normalized] : [source];
    const total = this.db.prepare(
      `SELECT COUNT(*) FROM mcp_market_entries WHERE ${filter}`,
    ).pluck().get(...params) as number;
    const rows = this.db.prepare(`
      SELECT * FROM mcp_market_entries
      WHERE ${filter}
      ORDER BY name COLLATE NOCASE, external_id
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as McpMarketEntryRow[];
    return { rows, total };
  }

  private entryUpsert() {
    return this.db.prepare(`
      INSERT INTO mcp_market_entries
        (source, external_id, name, description, repository_url, detail_url)
      VALUES
        (@source, @external_id, @name, @description, @repository_url, @detail_url)
      ON CONFLICT(source, external_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        repository_url = excluded.repository_url,
        detail_url = excluded.detail_url
    `);
  }

  private saveFetchState(source: string, nextCursor: string | null): void {
    this.db.prepare(`
      INSERT INTO mcp_market_fetch_state (source, next_cursor)
      VALUES (?, ?)
      ON CONFLICT(source) DO UPDATE SET next_cursor = excluded.next_cursor
    `).run(source, nextCursor);
  }
}
