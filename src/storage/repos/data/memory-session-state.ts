import type { SqliteDb } from '../../database/database.js';

interface StateRow {
  session_id:     string;
  surfaced_json:  string;
  overrides_json: string;
}

export class MemorySessionStateRepo {
  constructor(private readonly db: SqliteDb) {}

  private upsertRow(sessionId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_session_state (session_id)
         VALUES (?)`,
      )
      .run(sessionId);
  }

  getSurfaced(sessionId: string): Record<string, unknown> {
    const row = this.db
      .prepare('SELECT surfaced_json FROM memory_session_state WHERE session_id = ?')
      .get(sessionId) as Pick<StateRow, 'surfaced_json'> | undefined;
    if (!row) return {};
    try { return JSON.parse(row.surfaced_json) as Record<string, unknown>; } catch { return {}; }
  }

  setSurfaced(sessionId: string, data: Record<string, unknown>): void {
    this.upsertRow(sessionId);
    this.db
      .prepare('UPDATE memory_session_state SET surfaced_json = ? WHERE session_id = ?')
      .run(JSON.stringify(data), sessionId);
  }

  getOverrides(sessionId: string): Record<string, unknown> {
    const row = this.db
      .prepare('SELECT overrides_json FROM memory_session_state WHERE session_id = ?')
      .get(sessionId) as Pick<StateRow, 'overrides_json'> | undefined;
    if (!row) return {};
    try { return JSON.parse(row.overrides_json) as Record<string, unknown>; } catch { return {}; }
  }

  setOverrides(sessionId: string, data: Record<string, unknown>): void {
    this.upsertRow(sessionId);
    this.db
      .prepare('UPDATE memory_session_state SET overrides_json = ? WHERE session_id = ?')
      .run(JSON.stringify(data), sessionId);
  }
}
