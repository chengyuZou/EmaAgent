import type { SqliteDb } from '../../database/database.js';

export type ModelCapabilityRow = "llm" | "embed" | "rerank" | "vision" | "tts" | "stt";

export interface ProviderRow {
  id: string;
  name: string;
  icon_id: string | null;
  auth_type: 'none' | 'bearer';
  key_value: string | null;
}

export interface ProviderCapabilityRow {
  provider_id: string;
  capability: ModelCapabilityRow;
  active_protocol: string | null;
  models_dev_id: string | null;
}

export interface ProviderProtocolRow {
  provider_id: string;
  capability: ModelCapabilityRow;
  protocol: string;
  base_url: string;
}

export interface ProviderHealthRow {
  provider_id: string;
  capability: ModelCapabilityRow;
  status: 'ok' | 'failed' | 'unknown';
  last_probed_at: number | null;
  latency_ms: number | null;
  last_error: string | null;
}

export interface ProviderModelCountRow {
  capability: ModelCapabilityRow;
  count: number;
}

export interface ProviderSave {
  provider: ProviderRow;
  capabilities: readonly ProviderCapabilityRow[];
  protocols: readonly ProviderProtocolRow[];
}

export class ProvidersRepo {
  constructor(private readonly db: SqliteDb) {}

  get(id: string): ProviderRow | undefined {
    return this.db.prepare(
      `SELECT id, name, icon_id, auth_type, key_value
       FROM providers WHERE id = ?`,
    ).get(id) as ProviderRow | undefined;
  }

  list(): ProviderRow[] {
    const rows = this.db.prepare(
      `SELECT id, name, icon_id, auth_type, key_value
       FROM providers ORDER BY created_at ASC, id ASC`,
    ).all() as ProviderRow[];

    return rows;
  }

  save(input: ProviderSave): void {
    const now = Date.now();
    const { provider } = input;
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
        provider.id,
        provider.name,
        provider.icon_id,
        provider.auth_type,
        provider.key_value,
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
          capability.provider_id,
          capability.capability,
          capability.active_protocol,
          capability.models_dev_id,
          now,
          now,
        );
        // 协议全量替换：协议+地址的记忆以本次保存为准；能力行保留则模型事实不丢。
        this.db.prepare(
          `DELETE FROM provider_protocols
           WHERE provider_id = ? AND capability = ?`,
        ).run(capability.provider_id, capability.capability);
        for (const protocol of input.protocols.filter(
          (entry) => entry.capability === capability.capability,
        )) {
          insertProtocol.run(protocol.provider_id, protocol.capability, protocol.protocol, protocol.base_url, now, now);
        }
      }

      const retained = new Set(input.capabilities.map((entry) => entry.capability));
      for (const existing of this.listCapabilities(provider.id)) {
        if (retained.has(existing.capability)) continue;
        // 能力行删除经 FK 级联清理协议与模型事实。
        this.db.prepare(
          `DELETE FROM provider_capabilities
           WHERE provider_id = ? AND capability = ?`,
        ).run(provider.id, existing.capability);
      }
    })();
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  recordHealth(health: ProviderHealthRow): void {
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
      health.provider_id,
      health.capability,
      health.status,
      health.last_probed_at,
      health.latency_ms,
      health.last_error,
    );
  }

  listCapabilities(providerId: string): ProviderCapabilityRow[] {
    return this.db.prepare(
      `SELECT provider_id, capability, active_protocol, models_dev_id
       FROM provider_capabilities
       WHERE provider_id = ?
       ORDER BY capability ASC`,
    ).all(providerId) as ProviderCapabilityRow[];
  }

  listProtocols(providerId: string): ProviderProtocolRow[] {
    return this.db.prepare(
      `SELECT provider_id, capability, protocol, base_url
       FROM provider_protocols
       WHERE provider_id = ?
       ORDER BY capability ASC, protocol ASC`,
    ).all(providerId) as ProviderProtocolRow[];
  }

  listHealth(providerId: string): ProviderHealthRow[] {
    return this.db.prepare(
      `SELECT provider_id, capability, status, last_probed_at, latency_ms, last_error
       FROM provider_health WHERE provider_id = ?
       ORDER BY capability ASC`,
    ).all(providerId) as ProviderHealthRow[];
  }

  listModelCounts(providerId: string): ProviderModelCountRow[] {
    return this.db.prepare(
      `SELECT capability, COUNT(*) AS count FROM provider_models
       WHERE provider_id = ? GROUP BY capability`,
    ).all(providerId) as ProviderModelCountRow[];
  }
}
