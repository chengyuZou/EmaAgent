import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ContextSource = 'live' | 'table' | 'manual';

export interface ProviderLlmModelRow {
  provider_config_id: string;
  model:              string;
  context_window:     number;
  context_source:     ContextSource;
  created_at:         number;
  /** Joined from provider_configs — used for capability lookups (modelsDevId). */
  definition_id:      string | null;
}

export interface ProviderLlmModelInsert {
  providerConfigId: string;
  model:            string;
  contextWindow:    number;
  contextSource?:   ContextSource;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Per-provider ENABLED LLM model pool. A row ⟺ the user toggled the model ON
 * for that provider config. `model_bindings` (per module) draws from this pool;
 * disabling a model cascades to its bindings (handled in the providers route).
 */
export class ProviderLlmModelsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── Queries by provider ────────────────────────────────────────────────────

  /** Enabled models for one provider config — drives the provider page list. */
  listByProvider(providerConfigId: string): ProviderLlmModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_llm_models WHERE provider_config_id = ? ORDER BY created_at ASC')
      .all(providerConfigId) as ProviderLlmModelRow[];
  }

  // ── Queries by model ───────────────────────────────────────────────────────

  /**
   * All providers that have this model enabled — drives the frontend model
   * picker (same model name may exist under multiple provider configs).
   * JOINs definition_id so the caller can resolve modelsDevId for capability checks.
   */
  listByModel(model: string): ProviderLlmModelRow[] {
    return this.db
      .prepare(`SELECT plm.*, pc.definition_id
                FROM provider_llm_models plm
                JOIN provider_configs pc ON pc.id = plm.provider_config_id
                WHERE plm.model = ?
                ORDER BY plm.provider_config_id`)
      .all(model) as ProviderLlmModelRow[];
  }

  // ── Exact lookup ───────────────────────────────────────────────────────────

  /** Returns the full row (including definition_id) for a specific enabled model. */
  get(providerConfigId: string, model: string): ProviderLlmModelRow | undefined {
    return this.db
      .prepare(`SELECT plm.*, pc.definition_id
                FROM provider_llm_models plm
                JOIN provider_configs pc ON pc.id = plm.provider_config_id
                WHERE plm.provider_config_id = ? AND plm.model = ?`)
      .get(providerConfigId, model) as ProviderLlmModelRow | undefined;
  }

  // ── Whole pool ─────────────────────────────────────────────────────────────

  /** All enabled models across every provider. */
  listAll(): ProviderLlmModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_llm_models ORDER BY provider_config_id, created_at ASC')
      .all() as ProviderLlmModelRow[];
  }

  // ── Existence checks ───────────────────────────────────────────────────────

  /** Check whether a specific (provider, model) pair is enabled. */
  hasProviderModel(providerConfigId: string, model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_llm_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) !== undefined;
  }

  /** Check whether ANY provider has this model enabled. */
  hasModel(model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_llm_models WHERE model = ?')
      .get(model) !== undefined;
  }

  /**
   * Context window for a model name, across any provider that has it enabled.
   * Used by memory budgeting (getContextWindow). Returns undefined when no
   * enabled model matches → caller falls back to the static token table.
   */
  contextWindowFor(model: string): number | undefined {
    const row = this.db
      .prepare('SELECT context_window FROM provider_llm_models WHERE model = ? LIMIT 1')
      .get(model) as { context_window: number } | undefined;
    return row?.context_window;
  }

  /** Enable a model (or update its context window). */
  upsert(input: ProviderLlmModelInsert): void {
    this.db
      .prepare(
        `INSERT INTO provider_llm_models
           (provider_config_id, model, context_window, context_source, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_config_id, model) DO UPDATE SET
           context_window = excluded.context_window,
           context_source = excluded.context_source`,
      )
      .run(
        input.providerConfigId,
        input.model,
        input.contextWindow,
        input.contextSource ?? 'table',
        Date.now(),
      );
  }

  /** Disable a model. Returns true if a row was removed. */
  remove(providerConfigId: string, model: string): boolean {
    const info = this.db
      .prepare('DELETE FROM provider_llm_models WHERE provider_config_id = ? AND model = ?')
      .run(providerConfigId, model);
    return info.changes > 0;
  }
}
