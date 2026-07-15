import type { SqliteDb } from '../database.js';
import type { Capability } from '@ema-agent/contracts';
import type { CredentialFacade } from '@ema-agent/credential';

// ── 类型─────────────────────────────────────────────────────────────────────

export type HealthStatus = 'ok' | 'failed' | 'probing' | 'unknown';

export interface ProviderConfigRow {
  id: string;
  /** TS 注册表的 key（如 "siliconflow"、"deepseek"）。 */
  definition_id: string;
  display_name: string;
  /** 仅为当前进程内解密值；SQLite 对应列 credential_envelope 始终保存密文。 */
  credential: string | null;
  /** 可选，覆盖注册表的 defaultBaseUrl。 */
  base_url: string | null;
  enabled: number;
  /** JSON 对象 — Provider 特有的额外配置（如 { defaultModel: "..." }）。 */
  config_json: string;
  /** capability 字符串的 JSON 数组，如 '["llm","embed","rerank"]'。 */
  capabilities_json: string;
  created_at: number;
  updated_at: number;
}

interface StoredProviderConfigRow extends Omit<ProviderConfigRow, 'credential'> {
  credential_envelope: string | null;
}

export interface ProviderConfigInsert {
  id: string;
  definitionId: string;
  displayName: string;
  apiKey?: string | null;
  /** 留空则回退到注册表的 defaultBaseUrl。 */
  baseUrl?: string;
  enabled?: boolean;
  /** Provider 特有的额外配置 — 以 JSON 存储。 */
  config?: Record<string, unknown>;
  /** 用户希望启用的 capability（definition capabilities 的子集）。 */
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
 * Provider 生命周期的统一 Repo。
 *
 * 管理共享同一概念实体的两张表：
 *   provider_configs  — 连接信息（变化慢）
 *   provider_health   — 按 config id 索引的 probe 状态（变化快）
 *
 * 设置 UI 总是需要两者一起（列表展示 Provider 卡片带
 * 健康状态指示），通过单一 Repo 暴露可消除调用方的
 * 双取协调。
 */
export class ProvidersRepo {
  constructor(
    private readonly db: SqliteDb,
    private readonly credentials: CredentialFacade,
  ) {}

  private revealRow(row: StoredProviderConfigRow): ProviderConfigRow {
    const { credential_envelope: envelope, ...metadata } = row;
    return {
      ...metadata,
      credential: envelope === null ? null : this.credentials.reveal(row.id, envelope),
    };
  }

  /**
   * 将旧版本遗留的明文凭据原地升级为加密信封。
   * 整批写入在同一事务中完成；任意一行失败都不会留下半迁移状态。
   */
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

  // ── 配置写入───────────────────────────────────────────────────────────

  /** 插入或完全替换 Provider 配置。 */
  upsert(data: ProviderConfigInsert): void {
    const now = Date.now();
    const protectedApiKey = data.apiKey === undefined || data.apiKey === null
      ? null
      : this.credentials.protect(data.id, data.apiKey);
    this.db
      .prepare(
        `INSERT INTO provider_configs
           (id, definition_id, display_name, credential_envelope, base_url,
            enabled, config_json, capabilities_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           definition_id     = excluded.definition_id,
           display_name      = excluded.display_name,
           credential_envelope = excluded.credential_envelope,
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
        protectedApiKey,
        data.baseUrl ?? null,
        data.enabled !== false ? 1 : 0,
        JSON.stringify(data.config ?? {}),
        JSON.stringify(data.capabilities ?? ['llm']),
        now,
        now,
      );
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

  /**
   * 删除 Provider，并通过 FK 级联清理健康状态和模型池。
   * model_bindings 使用 RESTRICT；调用方必须先检查引用并要求用户换绑。
   */
  delete(id: string): void {
    this.db.prepare('DELETE FROM provider_configs WHERE id = ?').run(id);
  }

  // ── 配置读取────────────────────────────────────────────────────────────

  get(id: string): ProviderConfigRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM provider_configs WHERE id = ?')
      .get(id) as StoredProviderConfigRow | undefined;
    return row ? this.revealRow(row) : undefined;
  }

  /** 所有 Provider（不论是否启用） — 供设置 UI 列表使用。 */
  list(): ProviderConfigRow[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_configs ORDER BY created_at ASC')
      .all() as StoredProviderConfigRow[];
    return rows.map((row) => this.revealRow(row));
  }

  listEnabled(): ProviderConfigRow[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_configs WHERE enabled = 1 ORDER BY created_at ASC, id ASC')
      .all() as StoredProviderConfigRow[];
    return rows.map((row) => this.revealRow(row));
  }

  /**
   * 支持某 capability 的 Provider（仅启用的）。
   * 对 JSON 字符串数组使用 LIKE — 对存储的小数组足够用。
   */
  listByCapability(capability: string): ProviderConfigRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM provider_configs
         WHERE enabled = 1
           AND capabilities_json LIKE ?
         ORDER BY created_at ASC`,
      )
      .all(`%"${capability}"%`) as StoredProviderConfigRow[];
    return rows.map((row) => this.revealRow(row));
  }

  // ── 健康状态写入───────────────────────────────────────────────────────────

  /**
   * Upsert Provider 的健康状态记录。
   * status=failed 时，consecutive_fails 原子递增；
   * 其他 status 重置为 0。
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

  // ── 健康状态读取────────────────────────────────────────────────────────────

  getHealth(providerConfigId: string): ProviderHealthRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_health WHERE provider_config_id = ?')
      .get(providerConfigId) as ProviderHealthRow | undefined;
  }

  // ── 联合视图───────────────────────────────────────────────────────────

  /** 一次获取 Provider 配置 + 健康状态。供设置页面使用。 */
  getWithHealth(id: string): ProviderWithHealth | undefined {
    const config = this.get(id);
    if (!config) return undefined;
    return { config, health: this.getHealth(id) ?? null };
  }

  /** 所有 Provider 及其健康状态，供设置列表视图使用。 */
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
      .all() as Array<StoredProviderConfigRow & {
        h_status: HealthStatus | null;
        h_last_probed_at: number | null;
        h_latency_ms: number | null;
        h_last_error: string | null;
        h_consecutive_fails: number | null;
      }>;

    return rows.map(r => ({
      config: this.revealRow({
        id: r.id,
        definition_id: r.definition_id,
        display_name: r.display_name,
        credential_envelope: r.credential_envelope,
        base_url: r.base_url,
        enabled: r.enabled,
        config_json: r.config_json,
        capabilities_json: r.capabilities_json,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }),
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
