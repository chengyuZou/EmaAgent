// 把 Provider 控制面对象映射到 profile.db，并确保普通查询永不泄露明文凭据。
import type { CredentialFacade } from '@ema-agent/credential';
import type {
  ModelCapability,
  ProviderConfig,
  ProviderCapabilityConfig,
  ProviderConfigStore,
  ProviderHealth,
  ProviderWithHealth,
  SaveProviderConfig,
} from '@ema-agent/provider';
import type { Protocol } from '@ema-agent/provider';
import type { SqliteDb } from '../../database/database.js';

interface ProviderRow {
  id: string;
  provider_id: string | null;
  display_name: string;
  credential_envelope: string | null;
  enabled: number;
}

interface CapabilityRow {
  provider_config_id: string;
  capability: ModelCapability;
  protocol: Protocol;
  base_url: string;
  enabled: number;
}

interface HealthRow {
  status: ProviderHealth['status'];
  last_probed_at: number | null;
  latency_ms: number | null;
  last_error: string | null;
}

export class ProvidersRepo implements ProviderConfigStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly credentials: CredentialFacade,
  ) {}

  get(id: string): ProviderConfig | undefined {
    const row = this.getRow(id);
    return row ? this.toProvider(row, this.listCapabilities(id)) : undefined;
  }

  getWithHealth(id: string): ProviderWithHealth | undefined {
    const config = this.get(id);
    if (!config) return undefined;
    return { config, health: this.getHealth(id) };
  }

  listWithHealth(): ProviderWithHealth[] {
    const rows = this.db.prepare(
      `SELECT id, provider_id, display_name, credential_envelope, enabled
       FROM provider_configs
       ORDER BY created_at ASC, id ASC`,
    ).all() as ProviderRow[];
    return rows.map((row) => ({
      config: this.toProvider(row, this.listCapabilities(row.id)),
      health: this.getHealth(row.id),
    }));
  }

  revealCredential(id: string): string | null {
    const envelope = this.getRow(id)?.credential_envelope;
    return envelope ? this.credentials.reveal(id, envelope) : null;
  }

  save(input: SaveProviderConfig): void {
    const now = Date.now();
    const existingEnvelope = this.getRow(input.id)?.credential_envelope ?? null;
    const envelope = input.credential === undefined
      ? existingEnvelope
      : input.credential === null
        ? null
        : this.credentials.protect(input.id, input.credential);

    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO provider_configs
           (id, provider_id, display_name, credential_envelope, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_id = excluded.provider_id,
           display_name = excluded.display_name,
           credential_envelope = excluded.credential_envelope,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      ).run(
        input.id,
        input.providerId,
        input.displayName,
        envelope,
        input.enabled ? 1 : 0,
        now,
        now,
      );

      const upsert = this.db.prepare(
        `INSERT INTO provider_capability_configs
           (provider_config_id, capability, protocol, base_url, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_config_id, capability) DO UPDATE SET
           protocol = excluded.protocol,
           base_url = excluded.base_url,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      );
      for (const capability of input.capabilities) {
        upsert.run(
          input.id,
          capability.capability,
          capability.protocol,
          capability.baseUrl,
          capability.enabled ? 1 : 0,
          now,
          now,
        );
      }

      const retained = new Set(input.capabilities.map((entry) => entry.capability));
      for (const existing of this.listCapabilities(input.id)) {
        if (retained.has(existing.capability)) continue;
        this.db.prepare(
          `DELETE FROM provider_capability_configs
           WHERE provider_config_id = ? AND capability = ?`,
        ).run(input.id, existing.capability);
      }
    })();
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM provider_configs WHERE id = ?').run(id);
  }

  recordHealth(providerConfigId: string, health: ProviderHealth): void {
    this.db.prepare(
      `INSERT INTO provider_health
         (provider_config_id, status, last_probed_at, latency_ms, last_error)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider_config_id) DO UPDATE SET
         status = excluded.status,
         last_probed_at = excluded.last_probed_at,
         latency_ms = excluded.latency_ms,
         last_error = excluded.last_error`,
    ).run(
      providerConfigId,
      health.status,
      health.lastProbedAt,
      health.latencyMs,
      health.lastError,
    );
  }

  private getRow(id: string): ProviderRow | undefined {
    return this.db.prepare(
      `SELECT id, provider_id, display_name, credential_envelope, enabled
       FROM provider_configs WHERE id = ?`,
    ).get(id) as ProviderRow | undefined;
  }

  private listCapabilities(providerConfigId: string): CapabilityRow[] {
    return this.db.prepare(
      `SELECT provider_config_id, capability, protocol, base_url, enabled
       FROM provider_capability_configs
       WHERE provider_config_id = ?
       ORDER BY capability ASC`,
    ).all(providerConfigId) as CapabilityRow[];
  }

  private getHealth(providerConfigId: string): ProviderHealth | null {
    const row = this.db.prepare(
      `SELECT status, last_probed_at, latency_ms, last_error
       FROM provider_health WHERE provider_config_id = ?`,
    ).get(providerConfigId) as HealthRow | undefined;
    return row ? {
      status: row.status,
      lastProbedAt: row.last_probed_at,
      latencyMs: row.latency_ms,
      lastError: row.last_error,
    } : null;
  }

  private toProvider(
    row: ProviderRow,
    capabilities: readonly CapabilityRow[],
  ): ProviderConfig {
    return {
      id: row.id,
      providerId: row.provider_id,
      displayName: row.display_name,
      hasCredential: row.credential_envelope !== null,
      enabled: row.enabled === 1,
      capabilities: capabilities.map((entry) => ({
        capability: entry.capability,
        protocol: entry.protocol,
        baseUrl: entry.base_url,
        enabled: entry.enabled === 1,
      } as ProviderCapabilityConfig)),
    };
  }
}
