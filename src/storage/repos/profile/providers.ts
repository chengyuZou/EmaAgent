// 把 Provider 控制面对象映射到 profile.db：行、能力、协议、key 与按能力健康。
// V1 key 明文入库；恢复加密时在本文件读写两点接回即可。
import type {
  ModelCapability,
  Protocol,
  Provider,
  ProviderCapability,
  ProviderHealth,
  ProviderInput,
  ProviderKey,
  ProviderStore,
} from '@ema-agent/provider';
import type { SqliteDb } from '../../database/database.js';

interface ProviderRow {
  id: string;
  name: string;
  icon_id: string | null;
  auth_type: 'none' | 'bearer';
  enabled: number;
}

interface CapabilityRow {
  provider_id: string;
  capability: ModelCapability;
  active_protocol: Protocol | null;
  active_key_id: string | null;
  models_dev_id: string | null;
}

interface ProtocolRow {
  provider_id: string;
  capability: ModelCapability;
  protocol: Protocol;
  base_url: string;
}

interface KeyRow {
  id: string;
  provider_id: string;
  capability: ModelCapability;
  key_value: string;
  created_at: number;
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
      `SELECT id, name, icon_id, auth_type, enabled
       FROM providers ORDER BY created_at ASC, id ASC`,
    ).all() as ProviderRow[];
    return rows.map((row) => this.toProvider(row));
  }

  save(input: ProviderInput): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO providers
           (id, name, icon_id, auth_type, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           icon_id = excluded.icon_id,
           auth_type = excluded.auth_type,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      ).run(
        input.id,
        input.name,
        input.iconId ?? null,
        input.authType,
        input.enabled ? 1 : 0,
        now,
        now,
      );

      const upsertCapability = this.db.prepare(
        `INSERT INTO provider_capabilities
           (provider_id, capability, active_protocol, active_key_id, models_dev_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, capability) DO UPDATE SET
           active_protocol = excluded.active_protocol,
           active_key_id = excluded.active_key_id,
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
          capability.activeKeyId ?? null,
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
        // 能力行删除经 FK 级联清理协议与模型事实；该能力的 key 一并清除。
        this.db.prepare(
          `DELETE FROM provider_keys WHERE provider_id = ? AND capability = ?`,
        ).run(input.id, existing.capability);
        this.db.prepare(
          `DELETE FROM provider_capabilities
           WHERE provider_id = ? AND capability = ?`,
        ).run(input.id, existing.capability);
      }

      const insertKey = this.db.prepare(
        `INSERT INTO provider_keys (id, provider_id, capability, key_value, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const newKey of input.newKeys ?? []) {
        insertKey.run(newKey.id, input.id, newKey.capability, newKey.keyValue, now);
      }
    })();
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  listKeys(providerId: string, capability: ModelCapability): ProviderKey[] {
    const rows = this.db.prepare(
      `SELECT id, provider_id, capability, key_value, created_at
       FROM provider_keys
       WHERE provider_id = ? AND capability = ?
       ORDER BY created_at DESC, id DESC`,
    ).all(providerId, capability) as KeyRow[];
    return rows.map((row) => ({
      id: row.id,
      providerId: row.provider_id,
      capability: row.capability,
      keyValue: row.key_value,
      createdAt: row.created_at,
    }));
  }

  addKey(entry: {
    id: string;
    providerId: string;
    capability: ModelCapability;
    keyValue: string;
    createdAt: number;
  }): void {
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO provider_keys (id, provider_id, capability, key_value, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(entry.id, entry.providerId, entry.capability, entry.keyValue, entry.createdAt);
      this.setActiveKey(entry.providerId, entry.capability, entry.id);
    })();
  }

  setActiveKey(providerId: string, capability: ModelCapability, keyId: string): void {
    this.db.prepare(
      `UPDATE provider_capabilities
       SET active_key_id = ?, updated_at = ?
       WHERE provider_id = ? AND capability = ?`,
    ).run(keyId, Date.now(), providerId, capability);
  }

  deleteKey(keyId: string): void {
    this.db.prepare('DELETE FROM provider_keys WHERE id = ?').run(keyId);
  }

  latestKeyValue(providerId: string): string | undefined {
    const row = this.db.prepare(
      `SELECT key_value FROM provider_keys
       WHERE provider_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(providerId) as { key_value: string } | undefined;
    return row?.key_value;
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
      `SELECT id, name, icon_id, auth_type, enabled
       FROM providers WHERE id = ?`,
    ).get(id) as ProviderRow | undefined;
  }

  private listCapabilityRows(providerId: string): CapabilityRow[] {
    return this.db.prepare(
      `SELECT provider_id, capability, active_protocol, active_key_id, models_dev_id
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
        ...(entry.active_key_id === null ? {} : { activeKeyId: entry.active_key_id }),
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
      enabled: row.enabled === 1,
      capabilities,
      health,
    };
  }
}
