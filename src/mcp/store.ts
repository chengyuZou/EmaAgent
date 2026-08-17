// MCP 存储入口负责服务器配置与工具缓存的持久化转换和运行时校验。
import { Buffer }                from 'node:buffer';
import { randomUUID }            from 'node:crypto';
import type { McpServersRepo, McpServerRow } from '@ema-agent/storage';
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
//   - env/headers 明文直存直读(V1 暂不做凭据加密,后续在此收口)
//   - 用领域类型(非裸 DB 行)表达 CRUD
//
// 不管连接 - 那是 McpRegistry 的事。

export class McpServerStore {
  constructor(
    private readonly repo: McpServersRepo,
  ) {}

  register(
    name: string,
    config: McpServerConfig,
    sourceUrl?: string,
    provenance: McpInstallProvenance = { sourceKind: 'manual' },
  ): string {
    const trustedProvenance = McpInstallProvenanceSchema.parse(provenance);
    const existing = this.repo.findByName(name);
    // 更新沿用既有 id,保持记录身份稳定。
    const id = existing?.id ?? randomUUID();
    const configJson = JSON.stringify(config);
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

  private rowToRecord(row: McpServerRow): McpServerRecord {
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
      config:      McpServerConfigSchema.parse(rawConfig),
      cachedTools,
      cachedAt:    row.cached_at,
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
