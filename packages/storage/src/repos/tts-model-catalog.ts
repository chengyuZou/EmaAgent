import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TtsModelRow {
  model_name:          string;
  default_format:      string;
  default_sample_rate: number;
  supports_speed:      number;
  is_builtin:          number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

export class TtsModelCatalogRepo {
  constructor(private readonly db: SqliteDb) {}

  get(model: string): TtsModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM tts_model_catalog WHERE model_name = ?')
      .get(model) as TtsModelRow | undefined;
  }

  list(): TtsModelRow[] {
    return this.db
      .prepare('SELECT * FROM tts_model_catalog ORDER BY model_name ASC')
      .all() as TtsModelRow[];
  }

  upsert(model: TtsModelRow): void {
    this.db
      .prepare(
        `INSERT INTO tts_model_catalog
           (model_name, default_format, default_sample_rate, supports_speed, is_builtin)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(model_name) DO UPDATE SET
           default_format      = excluded.default_format,
           default_sample_rate = excluded.default_sample_rate,
           supports_speed      = excluded.supports_speed,
           is_builtin          = excluded.is_builtin`,
      )
      .run(
        model.model_name,
        model.default_format,
        model.default_sample_rate,
        model.supports_speed,
        model.is_builtin,
      );
  }

  delete(model: string): void {
    this.db.prepare('DELETE FROM tts_model_catalog WHERE model_name = ?').run(model);
  }
}
