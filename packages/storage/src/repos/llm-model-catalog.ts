import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LlmModelRow {
  model_name:      string;
  context_window:  number;
  supports_vision: number;
  supports_tools:  number;
  supports_think:  number;
  is_builtin:      number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Read-only catalog of known LLM models and their capabilities.
 *
 * Builtin rows are INSERTed in the profile migration; users can add custom
 * models via the settings UI (is_builtin = 0). The repo is intentionally
 * read-dominant — writes go through the providers route.
 */
export class LlmModelCatalogRepo {
  constructor(private readonly db: SqliteDb) {}

  get(model: string): LlmModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM llm_model_catalog WHERE model_name = ?')
      .get(model) as LlmModelRow | undefined;
  }

  list(): LlmModelRow[] {
    return this.db
      .prepare('SELECT * FROM llm_model_catalog ORDER BY model_name ASC')
      .all() as LlmModelRow[];
  }

  /** Look up context window. Returns 0 when the model is unknown (caller falls back to default). */
  contextWindow(model: string): number {
    const row = this.get(model);
    return row?.context_window ?? 0;
  }

  upsert(model: LlmModelRow): void {
    this.db
      .prepare(
        `INSERT INTO llm_model_catalog
           (model_name, context_window, supports_vision, supports_tools, supports_think, is_builtin)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(model_name) DO UPDATE SET
           context_window  = excluded.context_window,
           supports_vision = excluded.supports_vision,
           supports_tools  = excluded.supports_tools,
           supports_think  = excluded.supports_think,
           is_builtin      = excluded.is_builtin`,
      )
      .run(
        model.model_name,
        model.context_window,
        model.supports_vision,
        model.supports_tools,
        model.supports_think,
        model.is_builtin,
      );
  }

  delete(model: string): void {
    this.db.prepare('DELETE FROM llm_model_catalog WHERE model_name = ?').run(model);
  }
}
