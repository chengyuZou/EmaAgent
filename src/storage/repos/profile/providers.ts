import type {
  ModelCapability,
  Protocol,
  Provider,
  ProviderCapability,
  ProviderHealth,
  ProviderInput,
  ProviderStore,
} from '@ema-agent/providers';
import type { SqliteDb } from '../../database/database.js';

interface ProviderRow {
  id: string;
  name: string;
  icon_id: string | null;
  auth_type: 'none' | 'bearer';
  key_value: string | null;
}

interface CapabilityRow {
  provider_id: string;
  capability: ModelCapability;
  active_protocol: Protocol | null;
  models_dev_id: string | null;
}

interface ProtocolRow {
  provider_id: string;
  capability: ModelCapability;
  protocol: Protocol;
  base_url: string;
}

interface HealthRow {
  provider_id: string;
  capability: ModelCapability;
  status: ProviderHealth['status'];
  last_probed_at: number | null;
  latency_ms: number | null;
  last_error: string | null;
}

export class ProvidersRepo implements ProviderStore {
  constructor(private readonly db: SqliteDb) {}

  get(id: string): Provider | undefined {
    const row = this.getRow(id);
    return row ? this.toProvider(row) : undefined;
  }

  list(): Provider[] {
    const rows = this.db.prepare(
      `SELECT id, name, icon_id, auth_type, key_value
       FROM providers ORDER BY created_at ASC, id ASC`,
    ).all() as ProviderRow[];
    return rows.map((row) => this.toProvider(row));
  }

  save(input: ProviderInput): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO providers
           (id, name, icon_id, auth_type, key_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           icon_id = excluded.icon_id,
           auth_type = excluded.auth_type,
           key_value = excluded.key_value,
           updated_at = excluded.updated_at`,
      ).run(
        input.id,
        input.name,
        input.iconId ?? null,
        input.authType,
        input.keyValue ?? null,
        now,
        now,
      );

      const upsertCapability = this.db.prepare(
        `INSERT INTO provider_capabilities
           (provider_id, capability, active_protocol, models_dev_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, capability) DO UPDATE SET
           active_protocol = excluded.active_protocol,
           models_dev_id = excluded.models_dev_id,
           updated_at = excluded.updated_at`,
      );
      const insertProtocol = this.db.prepare(
        `INSERT INTO provider_protocols
           (provider_id, capability, protocol, base_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const capability of input.capabilities) {
        upsertCapability.run(
          input.id,
          capability.capability,
          capability.activeProtocol ?? null,
          capability.modelsDevId ?? null,
          now,
          now,
        );
        // 协议全量替换：协议+地址的记忆以本次保存为准；能力行保留则模型事实不丢。
        this.db.prepare(
          `DELETE FROM provider_protocols
           WHERE provider_id = ? AND capability = ?`,
        ).run(input.id, capability.capability);
        for (const protocol of capability.protocols) {
          insertProtocol.run(input.id, capability.capability, protocol.protocol, protocol.baseUrl, now, now);
        }
      }

      const retained = new Set(input.capabilities.map((entry) => entry.capability));
      for (const existing of this.listCapabilityRows(input.id)) {
        if (retained.has(existing.capability)) continue;
        // 能力行删除经 FK 级联清理协议与模型事实。
        this.db.prepare(
          `DELETE FROM provider_capabilities
           WHERE provider_id = ? AND capability = ?`,
        ).run(input.id, existing.capability);
      }
    })();
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  recordHealth(providerId: string, capability: ModelCapability, health: ProviderHealth): void {
    this.db.prepare(
      `INSERT INTO provider_health
         (provider_id, capability, status, last_probed_at, latency_ms, last_error)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, capability) DO UPDATE SET
         status = excluded.status,
         last_probed_at = excluded.last_probed_at,
         latency_ms = excluded.latency_ms,
         last_error = excluded.last_error`,
    ).run(
      providerId,
      capability,
      health.status,
      health.lastProbedAt,
      health.latencyMs,
      health.lastError,
    );
  }

  private getRow(id: string): ProviderRow | undefined {
    return this.db.prepare(
      `SELECT id, name, icon_id, auth_type, key_value
       FROM providers WHERE id = ?`,
    ).get(id) as ProviderRow | undefined;
  }

  private listCapabilityRows(providerId: string): CapabilityRow[] {
    return this.db.prepare(
      `SELECT provider_id, capability, active_protocol, models_dev_id
       FROM provider_capabilities
       WHERE provider_id = ?
       ORDER BY capability ASC`,
    ).all(providerId) as CapabilityRow[];
  }

  private listProtocolRows(providerId: string): ProtocolRow[] {
    return this.db.prepare(
      `SELECT provider_id, capability, protocol, base_url
       FROM provider_protocols
       WHERE provider_id = ?
       ORDER BY capability ASC, protocol ASC`,
    ).all(providerId) as ProtocolRow[];
  }

  private listHealthRows(providerId: string): HealthRow[] {
    return this.db.prepare(
      `SELECT provider_id, capability, status, last_probed_at, latency_ms, last_error
       FROM provider_health WHERE provider_id = ?
       ORDER BY capability ASC`,
    ).all(providerId) as HealthRow[];
  }

  private toProvider(row: ProviderRow): Provider {
    const protocols = this.listProtocolRows(row.id);
    const capabilities: ProviderCapability[] = this.listCapabilityRows(row.id)
      .map((entry) => ({
        capability: entry.capability,
        ...(entry.active_protocol === null ? {} : { activeProtocol: entry.active_protocol }),
        ...(entry.models_dev_id === null ? {} : { modelsDevId: entry.models_dev_id }),
        protocols: protocols
          .filter((protocol) => protocol.capability === entry.capability)
          .map((protocol) => ({ protocol: protocol.protocol, baseUrl: protocol.base_url })),
      }));
    const health: ProviderHealth[] = this.listHealthRows(row.id).map((entry) => ({
      capability: entry.capability,
      status: entry.status,
      lastProbedAt: entry.last_probed_at,
      latencyMs: entry.latency_ms,
      lastError: entry.last_error,
    }));
    return {
      id: row.id,
      name: row.name,
      ...(row.icon_id === null ? {} : { iconId: row.icon_id }),
      authType: row.auth_type,
      ...(row.key_value === null ? {} : { keyValue: row.key_value }),
      capabilities,
      health,
    };
  }
}
