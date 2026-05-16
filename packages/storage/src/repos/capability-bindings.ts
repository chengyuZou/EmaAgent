import type { SqliteDb } from '../database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Capability = 'embed' | 'rerank' | 'vision';

export interface CapabilityBindingRow {
  capability: Capability;
  provider_config_id: string;
  model: string;
  params_json: string;
  enabled: number;
}

export interface CapabilityBindingUpsert {
  capability: Capability;
  provider_config_id: string;
  model: string;
  /** Capability-specific settings. embed: { dim: number }. rerank: {}. */
  params: Record<string, unknown>;
  enabled?: boolean;
}

/**
 * Resolved binding — provider connection info joined in.
 * Ready to send directly to bridge /internal/configure.
 */
export interface ResolvedBinding {
  capability: Capability;
  model: string;
  apiKey: string;
  baseUrl: string;
  params: Record<string, unknown>;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

export class CapabilityBindingsRepo {
  constructor(private readonly db: SqliteDb) {}

  /** Upsert a capability binding. */
  upsert(data: CapabilityBindingUpsert): void {
    this.db
      .prepare(
        `INSERT INTO capability_bindings
           (capability, provider_config_id, model, params_json, enabled)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(capability) DO UPDATE SET
           provider_config_id = excluded.provider_config_id,
           model              = excluded.model,
           params_json        = excluded.params_json,
           enabled            = excluded.enabled`,
      )
      .run(
        data.capability,
        data.provider_config_id,
        data.model,
        JSON.stringify(data.params),
        data.enabled !== false ? 1 : 0,
      );
  }

  /** Get raw row for a capability, or undefined if not configured. */
  get(capability: Capability): CapabilityBindingRow | undefined {
    return this.db
      .prepare('SELECT * FROM capability_bindings WHERE capability = ?')
      .get(capability) as CapabilityBindingRow | undefined;
  }

  /**
   * Get active binding with provider connection info joined in.
   * Returns undefined if capability is not configured or not enabled.
   */
  getActive(capability: Capability): ResolvedBinding | undefined {
    const row = this.db
      .prepare(
        `SELECT
           cb.capability,
           cb.model,
           cb.params_json,
           pc.api_key_plain AS api_key,
           pc.base_url
         FROM capability_bindings cb
         JOIN provider_configs pc ON pc.id = cb.provider_config_id
         WHERE cb.capability = ? AND cb.enabled = 1`,
      )
      .get(capability) as
      | {
          capability: Capability;
          model: string;
          params_json: string;
          api_key: string | null;
          base_url: string | null;
        }
      | undefined;

    if (!row) return undefined;

    return {
      capability: row.capability,
      model: row.model,
      apiKey: row.api_key ?? '',
      baseUrl: row.base_url ?? '',
      params: JSON.parse(row.params_json) as Record<string, unknown>,
    };
  }

  /** List all bindings (for settings UI). */
  all(): CapabilityBindingRow[] {
    return this.db
      .prepare('SELECT * FROM capability_bindings')
      .all() as CapabilityBindingRow[];
  }

  delete(capability: Capability): void {
    this.db
      .prepare('DELETE FROM capability_bindings WHERE capability = ?')
      .run(capability);
  }
}
