import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DimSource = 'live' | 'table' | 'manual';

export interface ProviderEmbedModelRow {
  provider_config_id: string;
  model:              string;
  dim:                number;
  dim_source:         DimSource;
  created_at:         number;
}

export interface ProviderEmbedModelInsert {
  providerConfigId: string;
  model:            string;
  dim:              number;
  dimSource?:       DimSource;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Per-provider ENABLED embed model pool. A row ⟺ the user toggled the model ON.
 * `dim` is denormalized at enable time (static table > manual) so the memory
 * pipeline can size vector stores without a second lookup.
 */
export class ProviderEmbedModelsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── Queries by provider ──────────────────────────────────────────────────

  listByProvider(providerConfigId: string): ProviderEmbedModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_embed_models WHERE provider_config_id = ? ORDER BY created_at ASC')
      .all(providerConfigId) as ProviderEmbedModelRow[];
  }

  // ── Queries by model ─────────────────────────────────────────────────────

  /** All providers that have this embed model enabled. */
  listByModel(model: string): ProviderEmbedModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_embed_models WHERE model = ? ORDER BY provider_config_id')
      .all(model) as ProviderEmbedModelRow[];
  }

  // ── Exact lookup ─────────────────────────────────────────────────────────

  get(providerConfigId: string, model: string): ProviderEmbedModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_embed_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) as ProviderEmbedModelRow | undefined;
  }

  // ── Whole pool ───────────────────────────────────────────────────────────

  listAll(): ProviderEmbedModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_embed_models ORDER BY provider_config_id, created_at ASC')
      .all() as ProviderEmbedModelRow[];
  }

  // ── Existence checks ─────────────────────────────────────────────────────

  hasProviderModel(providerConfigId: string, model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_embed_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) !== undefined;
  }

  hasModel(model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_embed_models WHERE model = ?')
      .get(model) !== undefined;
  }

  /** Vector dimension for a model name, across any provider. Fallback for memory pipeline. */
  dimFor(model: string): number | undefined {
    const row = this.db
      .prepare('SELECT dim FROM provider_embed_models WHERE model = ? LIMIT 1')
      .get(model) as { dim: number } | undefined;
    return row?.dim;
  }

  upsert(input: ProviderEmbedModelInsert): void {
    this.db
      .prepare(
        `INSERT INTO provider_embed_models
           (provider_config_id, model, dim, dim_source, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_config_id, model) DO UPDATE SET
           dim        = excluded.dim,
           dim_source = excluded.dim_source`,
      )
      .run(input.providerConfigId, input.model, input.dim, input.dimSource ?? 'table', Date.now());
  }

  remove(providerConfigId: string, model: string): boolean {
    const info = this.db
      .prepare('DELETE FROM provider_embed_models WHERE provider_config_id = ? AND model = ?')
      .run(providerConfigId, model);
    return info.changes > 0;
  }
}
