import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmbedModelRow {
  model_name: string;
  dim:        number;
  max_tokens: number | null;
  is_builtin: number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

export class EmbedModelCatalogRepo {
  constructor(private readonly db: SqliteDb) {}

  get(model: string): EmbedModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM embed_model_catalog WHERE model_name = ?')
      .get(model) as EmbedModelRow | undefined;
  }

  list(): EmbedModelRow[] {
    return this.db
      .prepare('SELECT * FROM embed_model_catalog ORDER BY model_name ASC')
      .all() as EmbedModelRow[];
  }

  /** Look up vector dimension. Returns 0 when the model is unknown. */
  dim(model: string): number {
    const row = this.get(model);
    return row?.dim ?? 0;
  }

  upsert(model: EmbedModelRow): void {
    this.db
      .prepare(
        `INSERT INTO embed_model_catalog
           (model_name, dim, max_tokens, is_builtin)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(model_name) DO UPDATE SET
           dim        = excluded.dim,
           max_tokens = excluded.max_tokens,
           is_builtin = excluded.is_builtin`,
      )
      .run(model.model_name, model.dim, model.max_tokens, model.is_builtin);
  }

  delete(model: string): void {
    this.db.prepare('DELETE FROM embed_model_catalog WHERE model_name = ?').run(model);
  }
}
