import type { SqliteDb } from '../database.js';

export interface SettingRow {
  key: string;
  value_json: string;
  updated_at: number;
}

export type SettingReadResult =
  | { status: 'found'; value: unknown }
  | { status: 'missing' }
  | { status: 'corrupted'; rawValue: string };

export class SettingSerializationError extends Error {
  readonly code = 'storage/setting-serialization-failed';

  constructor(readonly key: string, cause?: unknown) {
    super(`Setting "${key}" cannot be serialized as JSON`, { cause });
    this.name = 'SettingSerializationError';
  }
}

export class SettingsRepo {
  constructor(private readonly db: SqliteDb) {}

  get(key: string): unknown {
    const result = this.read(key);
    return result.status === 'found' ? result.value : undefined;
  }

  /**
   * 读取设置并保留“缺失”和“数据损坏”的区别。
   * 普通业务可继续使用 get() 回退默认值，诊断工具则使用本方法定位坏数据。
   */
  read(key: string): SettingReadResult {
    const row = this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(key) as { value_json: string } | undefined;
    if (!row) return { status: 'missing' };

    try {
      return { status: 'found', value: JSON.parse(row.value_json) as unknown };
    } catch {
      return { status: 'corrupted', rawValue: row.value_json };
    }
  }

  set(key: string, value: unknown, updatedAt = Date.now()): void {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      throw new SettingSerializationError(key, error);
    }
    if (serialized === undefined) {
      throw new SettingSerializationError(
        key,
        new TypeError('JSON.stringify returned undefined'),
      );
    }

    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, serialized, updatedAt);
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  all(): SettingRow[] {
    return this.db.prepare('SELECT * FROM settings').all() as SettingRow[];
  }
}
