import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SttModelRow {
  model_name:          string;
  languages:           string;   // JSON array, '[]' = auto-detect
  supports_timestamps: number;
  max_duration_s:      number | null;
  is_builtin:          number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

export class SttModelCatalogRepo {
  constructor(private readonly db: SqliteDb) {}

  get(model: string): SttModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM stt_model_catalog WHERE model_name = ?')
      .get(model) as SttModelRow | undefined;
  }

  list(): SttModelRow[] {
    return this.db
      .prepare('SELECT * FROM stt_model_catalog ORDER BY model_name ASC')
      .all() as SttModelRow[];
  }

  upsert(model: SttModelRow): void {
    this.db
      .prepare(
        `INSERT INTO stt_model_catalog
           (model_name, languages, supports_timestamps, max_duration_s, is_builtin)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(model_name) DO UPDATE SET
           languages           = excluded.languages,
           supports_timestamps = excluded.supports_timestamps,
           max_duration_s      = excluded.max_duration_s,
           is_builtin          = excluded.is_builtin`,
      )
      .run(
        model.model_name,
        model.languages,
        model.supports_timestamps,
        model.max_duration_s,
        model.is_builtin,
      );
  }

  delete(model: string): void {
    this.db.prepare('DELETE FROM stt_model_catalog WHERE model_name = ?').run(model);
  }
}
