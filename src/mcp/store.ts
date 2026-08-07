// MCP 存储入口负责服务器配置与工具缓存的持久化转换、凭据加解密和运行时校验。
import { Buffer }                from 'node:buffer';
import { randomUUID }            from 'node:crypto';
import type { CredentialFacade } from '@ema-agent/credential';
import type { McpServersRepo }   from '@ema-agent/storage';
import type { McpInstallProvenance, McpServerConfig, McpServerRecord, McpToolInfo } from './types.js';
import { McpInstallProvenanceSchema, McpServerConfigSchema, McpToolInfoListSchema } from './types.js';
import { McpServerNotFoundError, McpUnsupportedTransportError } from './errors.js';
import {
  MAX_MCP_TOOL_SCHEMA_BYTES,
  assertMcpToolSchemaLimits,
} from './toolSchemaLimits.js';

// ── McpServerStore ────────────────────────────────────────────────────────────
//
// McpServersRepo 之上的业务逻辑层。
//
// 职责:
//   - 解析/序列化 McpServerConfig(JSON Schema 校验)
//   - stdio env 与 http headers 的值在写边界 protect、读边界 reveal;
//     domain 形式永远是明文,连接层不知道加密存在
//   - 用领域类型(非裸 DB 行)表达 CRUD
//
// 不管连接 - 那是 McpRegistry 的事。

export class McpServerStore {
  constructor(
    private readonly repo: McpServersRepo,
    private readonly credentials: CredentialFacade,
  ) {}

  register(
    name: string,
    config: McpServerConfig,
    sourceUrl?: string,
    provenance: McpInstallProvenance = { sourceKind: 'manual' },
  ): string {
    const trustedProvenance = McpInstallProvenanceSchema.parse(provenance);
    const existing = this.repo.findByName(name);
    // AAD 绑定记录 id:更新沿用既有 id,旧信封仍可 reveal;新记录先取 id 再加密。
    const id = existing?.id ?? randomUUID();
    const configJson = JSON.stringify(this.protectConfig(id, config));
    if (existing) {
      this.repo.update(existing.id, {
        configJson,
        sourceUrl:  sourceUrl ?? null,
        ...provenancePatch(trustedProvenance),
      });
      return existing.id;
    }
    this.repo.insert({
      id,
      name,
      source_url:   sourceUrl ?? null,
      install_source: trustedProvenance.sourceKind,
      registry_source_id: trustedProvenance.sourceKind === 'registry' ? trustedProvenance.registrySourceId : null,
      registry_entry_id:  trustedProvenance.sourceKind === 'registry' ? trustedProvenance.registryEntryId  : null,
      registry_version:   trustedProvenance.sourceKind === 'registry' ? trustedProvenance.registryVersion  : null,
      config_json:  configJson,
      tools_cache:  null,
      cached_at:    0,
      enabled:      1,
      installed_at: Date.now(),
    });
    return id;
  }

  /** 持久化成功连接时发现的工具列表(快速/离线启动)。 */
  cacheTools(name: string, tools: McpToolInfo[]): void {
    const row = this.repo.findByName(name);
    if (!row) return;
    assertMcpToolSchemaLimits(name, tools);
    this.repo.update(row.id, { toolsCache: JSON.stringify(tools), cachedAt: Date.now() });
  }

  setEnabled(name: string, enabled: boolean): void {
    const row = this.repo.findByName(name);
    if (!row) throw new McpServerNotFoundError(name);
    this.repo.update(row.id, { enabled: enabled ? 1 : 0 });
  }

  remove(name: string): void {
    const row = this.repo.findByName(name);
    if (!row) return;
    this.repo.deleteById(row.id);
  }

  findByName(name: string): McpServerRecord | null {
    const row = this.repo.findByName(name);
    return row ? this.rowToRecord(row) : null;
  }

  listAll(): McpServerRecord[] {
    return this.repo.listAll().map((r) => this.rowToRecord(r));
  }

  listEnabled(): McpServerRecord[] {
    return this.repo.listEnabled().map((r) => this.rowToRecord(r));
  }

  // ── 凭据边界:写保护、读揭示 ──────────────────────────────────────────────
  //
  // env/headers 的全部值一律加密,不猜"哪些算敏感";GCM AAD 绑定记录 id,
  // 两行密文被交换会拒绝解密。备份导出只含密文信封,结构上满足凭据不导出。

  private protectConfig(id: string, config: McpServerConfig): McpServerConfig {
    if (config.type === 'stdio') {
      if (!config.env) return config;
      return { ...config, env: this.mapValues(config.env, (v) => this.credentials.protect(id, v)) };
    }
    if (!config.headers) return config;
    return { ...config, headers: this.mapValues(config.headers, (v) => this.credentials.protect(id, v)) };
  }

  private revealConfig(id: string, config: McpServerConfig): McpServerConfig {
    // reveal 对非信封值原样透传(兼容加密迁移前写入的明文行)。
    if (config.type === 'stdio') {
      if (!config.env) return config;
      return { ...config, env: this.mapValues(config.env, (v) => this.credentials.reveal(id, v)) };
    }
    if (!config.headers) return config;
    return { ...config, headers: this.mapValues(config.headers, (v) => this.credentials.reveal(id, v)) };
  }

  private mapValues(
    record: Record<string, string>,
    fn: (value: string) => string,
  ): Record<string, string> {
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, fn(v)]));
  }

  // ── 私有 ──────────────────────────────────────────────────────────────

  private rowToRecord(row: {
    id: string; name: string; source_url: string | null;
    install_source?: 'manual' | 'import' | 'registry';
    registry_source_id?: string | null; registry_entry_id?: string | null;
    registry_version?: string | null;
    config_json: string; tools_cache?: string | null; cached_at?: number;
    enabled: number; installed_at: number;
  }): McpServerRecord {
    const rawConfig = JSON.parse(row.config_json) as unknown;
    if (
      rawConfig !== null &&
      typeof rawConfig === 'object' &&
      !Array.isArray(rawConfig) &&
      (rawConfig as { type?: unknown }).type === 'sse'
    ) {
      throw new McpUnsupportedTransportError(row.name, 'sse');
    }

    let cachedTools: McpToolInfo[] | undefined;
    if (
      row.tools_cache
      && Buffer.byteLength(row.tools_cache, 'utf8') <= MAX_MCP_TOOL_SCHEMA_BYTES
    ) {
      try {
        const parsed = McpToolInfoListSchema.safeParse(JSON.parse(row.tools_cache));
        cachedTools = parsed.success ? parsed.data : undefined;
      } catch {
        cachedTools = undefined;
      }
    }
    const parsedProvenance = McpInstallProvenanceSchema.safeParse(
      row.install_source === 'registry'
        && row.registry_source_id && row.registry_entry_id && row.registry_version
        ? {
            sourceKind: 'registry',
            registrySourceId: row.registry_source_id,
            registryEntryId:  row.registry_entry_id,
            registryVersion:  row.registry_version,
          }
        : { sourceKind: row.install_source === 'import' ? 'import' : 'manual' },
    );
    return {
      id:          row.id,
      name:        row.name,
      sourceUrl:   row.source_url ?? undefined,
      // 损坏或旧版不完整 provenance 降级为 manual,绝不虚报"registry 版本已锁定"。
      provenance: parsedProvenance.success
        ? parsedProvenance.data
        : { sourceKind: 'manual' },
      config:      this.revealConfig(row.id, McpServerConfigSchema.parse(rawConfig)),
      cachedTools,
      cachedAt:    row.cached_at ?? 0,
      enabled:     row.enabled === 1,
      installedAt: row.installed_at,
    };
  }
}

function provenancePatch(provenance: McpInstallProvenance) {
  return {
    installSource: provenance.sourceKind,
    registrySourceId: provenance.sourceKind === 'registry' ? provenance.registrySourceId : null,
    registryEntryId:  provenance.sourceKind === 'registry' ? provenance.registryEntryId  : null,
    registryVersion:  provenance.sourceKind === 'registry' ? provenance.registryVersion  : null,
  };
}
