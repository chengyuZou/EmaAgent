import type { SqliteDb } from '../database.js';

export interface SettingRow {
  key: string;
  value_json: string;
  updated_at: number;
}

export class SettingsRepo {
  constructor(private readonly db: SqliteDb) {}

  get(key: string): unknown {
    const row = this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value_json);
  }

  set(key: string, value: unknown, updatedAt = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), updatedAt);
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  all(): SettingRow[] {
    return this.db.prepare('SELECT * FROM settings').all() as SettingRow[];
  }
}
