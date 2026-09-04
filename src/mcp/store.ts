// MCP 存储入口负责服务器配置与工具缓存的持久化转换和读取校验。
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
        ...provenancePatch(trustedProvenance),
      });
      return existing.id;
    }
    this.repo.insert({
      id,
      name,
      install_source: trustedProvenance.sourceKind,
      market_entry_id: trustedProvenance.sourceKind === 'official'
        ? trustedProvenance.marketEntryId
        : null,
      config_json:  configJson,
      tools_cache:  null,
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
    this.repo.update(row.id, { toolsCache: JSON.stringify(tools) });
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
    const parsedProvenance = McpInstallProvenanceSchema.parse(
      row.install_source === 'official' && row.market_entry_id
        ? { sourceKind: row.install_source, marketEntryId: row.market_entry_id }
        : { sourceKind: row.install_source },
    );
    return {
      id:          row.id,
      name:        row.name,
      provenance: parsedProvenance,
      config:      McpServerConfigSchema.parse(rawConfig),
      cachedTools,
      enabled:     row.enabled === 1,
    };
  }
}

function provenancePatch(provenance: McpInstallProvenance) {
  return {
    installSource: provenance.sourceKind,
    marketEntryId: provenance.sourceKind === 'official'
      ? provenance.marketEntryId
      : null,
  };
}
