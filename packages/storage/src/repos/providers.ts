import type { SqliteDb } from '../database.js';
import type { Capability } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type HealthStatus = 'ok' | 'failed' | 'probing' | 'unknown';

export interface ProviderConfigRow {
  id: string;
  /** Key into the TS registry (e.g. "siliconflow", "deepseek"). */
  definition_id: string;
  display_name: string;
  api_key_plain: string | null;
  /** Optional override of registry's defaultBaseUrl. */
  base_url: string | null;
  enabled: number;
  /** JSON object — provider-specific extras (e.g. { defaultModel: "..." }). */
  config_json: string;
  /** JSON array of capability strings, e.g. '["llm","embed","rerank"]'. */
  capabilities_json: string;
  created_at: number;
  updated_at: number;
}

export interface ProviderConfigInsert {
  id: string;
  definitionId: string;
  displayName: string;
  apiKey?: string;
  /** Leave undefined to fall back to the registry's defaultBaseUrl. */
  baseUrl?: string;
  enabled?: boolean;
  /** Provider-specific extras — stored as JSON. */
  config?: Record<string, unknown>;
  /** Which capabilities the user wants enabled (subset of the definition's capabilities). */
  capabilities?: Capability[];
}

export interface ProviderHealthRow {
  provider_config_id: string;
  status: HealthStatus;
  last_probed_at: number | null;
  latency_ms: number | null;
  last_error: string | null;
  consecutive_fails: number;
}

export interface ProviderWithHealth {
  config: ProviderConfigRow;
  health: ProviderHealthRow | null;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Unified Repo for the provider lifecycle.
 *
 * Manages two tables that share the same conceptual entity:
 *   provider_configs  — connection info (slow-changing)
 *   provider_health   — probe status keyed by config id (fast-changing)
 *
 * The settings UI always wants both together (list provider cards with
 * a health indicator), so exposing them through one Repo eliminates
 * dual-fetching coordination at the caller side.
 */
export class ProvidersRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── Config write ───────────────────────────────────────────────────────────

  /** Insert or fully replace a provider config. */
  upsert(data: ProviderConfigInsert): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO provider_configs
           (id, definition_id, display_name, api_key_plain, base_url,
            enabled, config_json, capabilities_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           definition_id     = excluded.definition_id,
           display_name      = excluded.display_name,
           api_key_plain     = excluded.api_key_plain,
           base_url          = excluded.base_url,
           enabled           = excluded.enabled,
           config_json       = excluded.config_json,
           capabilities_json = excluded.capabilities_json,
           updated_at        = excluded.updated_at`,
      )
      .run(
        data.id,
        data.definitionId,
        data.displayName,
        data.apiKey ?? null,
        data.baseUrl ?? null,
        data.enabled !== false ? 1 : 0,
        JSON.stringify(data.config ?? {}),
        JSON.stringify(data.capabilities ?? ['llm']),
        now,
        now,
      );
  }

  updateApiKey(id: string, apiKey: string): void {
    this.db
      .prepare('UPDATE provider_configs SET api_key_plain = ?, updated_at = ? WHERE id = ?')
      .run(apiKey, Date.now(), id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE provider_configs SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
  }

  /** Cascades to provider_health via FK. */
  delete(id: string): void {
    this.db.prepare('DELETE FROM provider_configs WHERE id = ?').run(id);
  }

  // ── Config read ────────────────────────────────────────────────────────────

  get(id: string): ProviderConfigRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_configs WHERE id = ?')
      .get(id) as ProviderConfigRow | undefined;
  }

  /** All providers, enabled or not — for the settings UI list. */
  list(): ProviderConfigRow[] {
    return this.db
      .prepare('SELECT * FROM provider_configs ORDER BY created_at ASC')
      .all() as ProviderConfigRow[];
  }

  listEnabled(): ProviderConfigRow[] {
    return this.db
      .prepare('SELECT * FROM provider_configs WHERE enabled = 1')
      .all() as ProviderConfigRow[];
  }

  /**
   * Providers that support a given capability (enabled only).
   * Uses LIKE on the JSON-stringified array — fine for the small arrays we store.
   */
  listByCapability(capability: string): ProviderConfigRow[] {
    return this.db
      .prepare(
        `SELECT * FROM provider_configs
         WHERE enabled = 1
           AND capabilities_json LIKE ?
         ORDER BY created_at ASC`,
      )
      .all(`%"${capability}"%`) as ProviderConfigRow[];
  }

  // ── Health write ───────────────────────────────────────────────────────────

  /**
   * Upsert health record for a provider.
   * On status=failed, consecutive_fails is incremented atomically;
   * any other status resets it to 0.
   */
  recordHealth(
    providerConfigId: string,
    status: HealthStatus,
    opts: { latencyMs?: number; lastError?: string; probedAt?: number } = {},
  ): void {
    const now = opts.probedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO provider_health
           (provider_config_id, status, last_probed_at, latency_ms, last_error, consecutive_fails)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_config_id) DO UPDATE SET
           status            = excluded.status,
           last_probed_at    = excluded.last_probed_at,
           latency_ms        = excluded.latency_ms,
           last_error        = excluded.last_error,
           consecutive_fails = CASE
             WHEN excluded.status = 'failed' THEN consecutive_fails + 1
             ELSE 0
           END`,
      )
      .run(
        providerConfigId,
        status,
        now,
        opts.latencyMs ?? null,
        opts.lastError ?? null,
        status === 'failed' ? 1 : 0,
      );
  }

  // ── Health read ────────────────────────────────────────────────────────────

  getHealth(providerConfigId: string): ProviderHealthRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_health WHERE provider_config_id = ?')
      .get(providerConfigId) as ProviderHealthRow | undefined;
  }

  // ── Joined views ───────────────────────────────────────────────────────────

  /** Provider config + health in one fetch. Used by the settings page. */
  getWithHealth(id: string): ProviderWithHealth | undefined {
    const config = this.get(id);
    if (!config) return undefined;
    return { config, health: this.getHealth(id) ?? null };
  }

  /** All providers with their health for the settings list view. */
  listWithHealth(): ProviderWithHealth[] {
    const rows = this.db
      .prepare(
        `SELECT
           pc.*,
           ph.status            AS h_status,
           ph.last_probed_at    AS h_last_probed_at,
           ph.latency_ms        AS h_latency_ms,
           ph.last_error        AS h_last_error,
           ph.consecutive_fails AS h_consecutive_fails
         FROM provider_configs pc
         LEFT JOIN provider_health ph ON ph.provider_config_id = pc.id
         ORDER BY pc.created_at ASC`,
      )
      .all() as Array<ProviderConfigRow & {
        h_status: HealthStatus | null;
        h_last_probed_at: number | null;
        h_latency_ms: number | null;
        h_last_error: string | null;
        h_consecutive_fails: number | null;
      }>;

    return rows.map(r => ({
      config: {
        id: r.id,
        definition_id: r.definition_id,
        display_name: r.display_name,
        api_key_plain: r.api_key_plain,
        base_url: r.base_url,
        enabled: r.enabled,
        config_json: r.config_json,
        capabilities_json: r.capabilities_json,
        created_at: r.created_at,
        updated_at: r.updated_at,
      },
      health: r.h_status === null ? null : {
        provider_config_id: r.id,
        status: r.h_status,
        last_probed_at: r.h_last_probed_at,
        latency_ms: r.h_latency_ms,
        last_error: r.h_last_error,
        consecutive_fails: r.h_consecutive_fails ?? 0,
      },
    }));
  }
}
