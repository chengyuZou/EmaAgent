import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RerankModelRow {
  model_name: string;
  max_chunks: number | null;
  is_builtin: number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

export class RerankModelCatalogRepo {
  constructor(private readonly db: SqliteDb) {}

  get(model: string): RerankModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM rerank_model_catalog WHERE model_name = ?')
      .get(model) as RerankModelRow | undefined;
  }

  list(): RerankModelRow[] {
    return this.db
      .prepare('SELECT * FROM rerank_model_catalog ORDER BY model_name ASC')
      .all() as RerankModelRow[];
  }

  upsert(model: RerankModelRow): void {
    this.db
      .prepare(
        `INSERT INTO rerank_model_catalog
           (model_name, max_chunks, is_builtin)
         VALUES (?, ?, ?)
         ON CONFLICT(model_name) DO UPDATE SET
           max_chunks = excluded.max_chunks,
           is_builtin = excluded.is_builtin`,
      )
      .run(model.model_name, model.max_chunks, model.is_builtin);
  }

  delete(model: string): void {
    this.db.prepare('DELETE FROM rerank_model_catalog WHERE model_name = ?').run(model);
  }
}
