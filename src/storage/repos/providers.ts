// 管理 Provider 实例、能力级连接配置和健康状态，向业务层返回解密后的完整聚合对象。
import type { CredentialFacade } from '@ema-agent/credential';
import type { Capability, ProtocolFamily } from '@ema-agent/provider';
import type { SqliteDb } from '../database.js';

export type HealthStatus = 'ok' | 'failed' | 'probing' | 'unknown';

export interface ProviderCapabilityConfigRow {
  provider_config_id: string;
  capability: Capability;
  protocol: ProtocolFamily | null;
  base_url: string | null;
  embedding_revision: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface ProviderConfigRow {
  id: string;
  definition_id: string;
  display_name: string;
  /** 仅为当前进程内解密值；SQLite 始终保存 credential_envelope。 */
  credential: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
  capabilities: ProviderCapabilityConfigRow[];
}

interface StoredProviderConfigRow extends Omit<ProviderConfigRow, 'credential' | 'capabilities'> {
  credential_envelope: string | null;
}

export interface ProviderCapabilityConfigInput {
  capability: Capability;
  /** 留空表示使用 Provider 定义中该能力的首选协议。 */
  protocol?: ProtocolFamily | null;
  /** 留空表示使用 Provider 定义或协议声明的默认地址。 */
  baseUrl?: string | null;
  /** 仅 Embed 使用，用于区分同名模型的向量空间版本。 */
  embeddingRevision?: string | null;
  enabled?: boolean;
}

export interface ProviderConfigInsert {
  id: string;
  definitionId: string;
  displayName: string;
  /** undefined 保留原凭据，null 清空凭据，string 替换凭据。 */
  apiKey?: string | null;
  enabled?: boolean;
  capabilities: ProviderCapabilityConfigInput[];
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

export class ProvidersRepo {
  constructor(
    private readonly db: SqliteDb,
    private readonly credentials: CredentialFacade,
  ) {}

  private revealRow(
    row: StoredProviderConfigRow,
    capabilities: ProviderCapabilityConfigRow[],
  ): ProviderConfigRow {
    return {
      id: row.id,
      definition_id: row.definition_id,
      display_name: row.display_name,
      credential: row.credential_envelope === null
        ? null
        : this.credentials.reveal(row.id, row.credential_envelope),
      enabled: row.enabled,
      created_at: row.created_at,
      updated_at: row.updated_at,
      capabilities,
    };
  }

  private getStored(id: string): StoredProviderConfigRow | undefined {
    return this.db.prepare(
      `SELECT id, definition_id, display_name, credential_envelope,
              enabled, created_at, updated_at
       FROM provider_configs
       WHERE id = ?`,
    ).get(id) as StoredProviderConfigRow | undefined;
  }

  private listCapabilities(providerConfigId: string): ProviderCapabilityConfigRow[] {
    return this.db.prepare(
      `SELECT provider_config_id, capability, protocol, base_url,
              embedding_revision, enabled, created_at, updated_at
       FROM provider_capability_configs
       WHERE provider_config_id = ?
       ORDER BY capability ASC`,
    ).all(providerConfigId) as ProviderCapabilityConfigRow[];
  }

  private attachCapabilities(rows: StoredProviderConfigRow[]): ProviderConfigRow[] {
    if (rows.length === 0) return [];
    const capabilityRows = this.db.prepare(
      `SELECT provider_config_id, capability, protocol, base_url,
              embedding_revision, enabled, created_at, updated_at
       FROM provider_capability_configs
       ORDER BY provider_config_id ASC, capability ASC`,
    ).all() as ProviderCapabilityConfigRow[];
    const byProvider = new Map<string, ProviderCapabilityConfigRow[]>();
    for (const capability of capabilityRows) {
      const group = byProvider.get(capability.provider_config_id) ?? [];
      group.push(capability);
      byProvider.set(capability.provider_config_id, group);
    }
    return rows.map((row) => this.revealRow(row, byProvider.get(row.id) ?? []));
  }

  protectLegacyCredentials(): number {
    const rows = this.db
      .prepare('SELECT id, credential_envelope FROM provider_configs WHERE credential_envelope IS NOT NULL')
      .all() as Array<Pick<StoredProviderConfigRow, 'id' | 'credential_envelope'>>;
    const legacyRows = rows.filter(
      (row): row is { id: string; credential_envelope: string } =>
        row.credential_envelope !== null && !this.credentials.isProtected(row.credential_envelope),
    );
    if (legacyRows.length === 0) return 0;

    const update = this.db.prepare(
      'UPDATE provider_configs SET credential_envelope = ?, updated_at = ? WHERE id = ?',
    );
    const now = Date.now();
    this.db.transaction(() => {
      for (const row of legacyRows) {
        update.run(this.credentials.protect(row.id, row.credential_envelope), now, row.id);
      }
    })();
    return legacyRows.length;
  }

  upsert(data: ProviderConfigInsert): void {
    const now = Date.now();
    const currentEnvelope = this.getStored(data.id)?.credential_envelope ?? null;
    const credentialEnvelope = data.apiKey === undefined
      ? currentEnvelope
      : data.apiKey === null
        ? null
        : this.credentials.protect(data.id, data.apiKey);

    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO provider_configs
           (id, definition_id, display_name, credential_envelope, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           definition_id       = excluded.definition_id,
           display_name        = excluded.display_name,
           credential_envelope = excluded.credential_envelope,
           enabled             = excluded.enabled,
           updated_at          = excluded.updated_at`,
      ).run(
        data.id,
        data.definitionId,
        data.displayName,
        credentialEnvelope,
        data.enabled !== false ? 1 : 0,
        now,
        now,
      );
      this.replaceCapabilities(data.id, data.capabilities, now);
    })();
  }

  private replaceCapabilities(
    providerConfigId: string,
    capabilities: ProviderCapabilityConfigInput[],
    now = Date.now(),
  ): void {
    const existingCreatedAt = new Map(
      this.listCapabilities(providerConfigId).map((row) => [row.capability, row.created_at]),
    );
    this.db.prepare(
      'DELETE FROM provider_capability_configs WHERE provider_config_id = ?',
    ).run(providerConfigId);
    const insert = this.db.prepare(
      `INSERT INTO provider_capability_configs
         (provider_config_id, capability, protocol, base_url,
          embedding_revision, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const capability of capabilities) {
      insert.run(
        providerConfigId,
        capability.capability,
        capability.protocol ?? null,
        capability.baseUrl ?? null,
        capability.embeddingRevision ?? null,
        capability.enabled !== false ? 1 : 0,
        existingCreatedAt.get(capability.capability) ?? now,
        now,
      );
    }
  }

  upsertCapability(providerConfigId: string, capability: ProviderCapabilityConfigInput): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO provider_capability_configs
           (provider_config_id, capability, protocol, base_url,
            embedding_revision, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_config_id, capability) DO UPDATE SET
           protocol           = excluded.protocol,
           base_url            = excluded.base_url,
           embedding_revision  = excluded.embedding_revision,
           enabled             = excluded.enabled,
           updated_at          = excluded.updated_at`,
      ).run(
        providerConfigId,
        capability.capability,
        capability.protocol ?? null,
        capability.baseUrl ?? null,
        capability.embeddingRevision ?? null,
        capability.enabled !== false ? 1 : 0,
        now,
        now,
      );
      this.db.prepare(
        'UPDATE provider_configs SET updated_at = ? WHERE id = ?',
      ).run(now, providerConfigId);
    })();
  }

  updateApiKey(id: string, apiKey: string | null): void {
    const protectedApiKey = apiKey === null ? null : this.credentials.protect(id, apiKey);
    this.db
      .prepare('UPDATE provider_configs SET credential_envelope = ?, updated_at = ? WHERE id = ?')
      .run(protectedApiKey, Date.now(), id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE provider_configs SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM provider_configs WHERE id = ?').run(id);
  }

  get(id: string): ProviderConfigRow | undefined {
    const row = this.getStored(id);
    return row ? this.revealRow(row, this.listCapabilities(id)) : undefined;
  }

  list(): ProviderConfigRow[] {
    const rows = this.db.prepare(
      `SELECT id, definition_id, display_name, credential_envelope,
              enabled, created_at, updated_at
       FROM provider_configs
       ORDER BY created_at ASC, id ASC`,
    ).all() as StoredProviderConfigRow[];
    return this.attachCapabilities(rows);
  }

  listEnabled(): ProviderConfigRow[] {
    const rows = this.db.prepare(
      `SELECT id, definition_id, display_name, credential_envelope,
              enabled, created_at, updated_at
       FROM provider_configs
       WHERE enabled = 1
       ORDER BY created_at ASC, id ASC`,
    ).all() as StoredProviderConfigRow[];
    return this.attachCapabilities(rows);
  }

  listByCapability(capability: Capability): ProviderConfigRow[] {
    const rows = this.db.prepare(
      `SELECT pc.id, pc.definition_id, pc.display_name, pc.credential_envelope,
              pc.enabled, pc.created_at, pc.updated_at
       FROM provider_configs pc
       JOIN provider_capability_configs pcc
         ON pcc.provider_config_id = pc.id
        AND pcc.capability = ?
        AND pcc.enabled = 1
       WHERE pc.enabled = 1
       ORDER BY pc.created_at ASC, pc.id ASC`,
    ).all(capability) as StoredProviderConfigRow[];
    return this.attachCapabilities(rows);
  }

  recordHealth(
    providerConfigId: string,
    status: HealthStatus,
    opts: { latencyMs?: number; lastError?: string; probedAt?: number } = {},
  ): void {
    const now = opts.probedAt ?? Date.now();
    this.db.prepare(
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
    ).run(
      providerConfigId,
      status,
      now,
      opts.latencyMs ?? null,
      opts.lastError ?? null,
      status === 'failed' ? 1 : 0,
    );
  }

  getHealth(providerConfigId: string): ProviderHealthRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_health WHERE provider_config_id = ?')
      .get(providerConfigId) as ProviderHealthRow | undefined;
  }

  getWithHealth(id: string): ProviderWithHealth | undefined {
    const config = this.get(id);
    if (!config) return undefined;
    return { config, health: this.getHealth(id) ?? null };
  }

  listWithHealth(): ProviderWithHealth[] {
    const rows = this.db.prepare(
      `SELECT pc.id, pc.definition_id, pc.display_name, pc.credential_envelope,
              pc.enabled, pc.created_at, pc.updated_at,
              ph.status AS health_status,
              ph.last_probed_at AS health_last_probed_at,
              ph.latency_ms AS health_latency_ms,
              ph.last_error AS health_last_error,
              ph.consecutive_fails AS health_consecutive_fails
       FROM provider_configs pc
       LEFT JOIN provider_health ph ON ph.provider_config_id = pc.id
       ORDER BY pc.created_at ASC, pc.id ASC`,
    ).all() as Array<StoredProviderConfigRow & {
      health_status: HealthStatus | null;
      health_last_probed_at: number | null;
      health_latency_ms: number | null;
      health_last_error: string | null;
      health_consecutive_fails: number | null;
    }>;
    const configs = this.attachCapabilities(rows);
    return configs.map((config, index) => {
      const row = rows[index]!;
      return {
        config,
        health: row.health_status === null ? null : {
          provider_config_id: config.id,
          status: row.health_status,
          last_probed_at: row.health_last_probed_at,
          latency_ms: row.health_latency_ms,
          last_error: row.health_last_error,
          consecutive_fails: row.health_consecutive_fails ?? 0,
        },
      };
    });
  }
}
