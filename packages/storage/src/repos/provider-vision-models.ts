import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProviderVisionModelRow {
  provider_config_id: string;
  model:              string;
  created_at:         number;
}

export interface ProviderVisionModelInsert {
  providerConfigId: string;
  model:            string;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Per-provider ENABLED vision model pool. A row ⟺ the user toggled the model ON.
 * Vision models have no extra metadata columns — capability flags
 * (inputModalities etc.) come from the models.dev catalog at runtime.
 */
export class ProviderVisionModelsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── Queries by provider ──────────────────────────────────────────────────

  listByProvider(providerConfigId: string): ProviderVisionModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_vision_models WHERE provider_config_id = ? ORDER BY created_at ASC')
      .all(providerConfigId) as ProviderVisionModelRow[];
  }

  // ── Queries by model ─────────────────────────────────────────────────────

  /** All providers that have this vision model enabled. */
  listByModel(model: string): ProviderVisionModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_vision_models WHERE model = ? ORDER BY provider_config_id')
      .all(model) as ProviderVisionModelRow[];
  }

  // ── Exact lookup ─────────────────────────────────────────────────────────

  get(providerConfigId: string, model: string): ProviderVisionModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_vision_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) as ProviderVisionModelRow | undefined;
  }

  // ── Whole pool ───────────────────────────────────────────────────────────

  listAll(): ProviderVisionModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_vision_models ORDER BY provider_config_id, created_at ASC')
      .all() as ProviderVisionModelRow[];
  }

  // ── Existence checks ─────────────────────────────────────────────────────

  hasProviderModel(providerConfigId: string, model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_vision_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) !== undefined;
  }

  hasModel(model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_vision_models WHERE model = ?')
      .get(model) !== undefined;
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  upsert(input: ProviderVisionModelInsert): void {
    this.db
      .prepare(
        `INSERT INTO provider_vision_models (provider_config_id, model, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(provider_config_id, model) DO NOTHING`,
      )
      .run(input.providerConfigId, input.model, Date.now());
  }

  remove(providerConfigId: string, model: string): boolean {
    const info = this.db
      .prepare('DELETE FROM provider_vision_models WHERE provider_config_id = ? AND model = ?')
      .run(providerConfigId, model);
    return info.changes > 0;
  }
}
