import { Buffer }                from 'node:buffer';
import { randomUUID }            from 'node:crypto';
import type { McpServersRepo, McpServerRow, McpServerSettingsRow } from '@ema-agent/storage';
import type {
  McpAuthType,
  McpInstallProvenance,
  McpServerConfig,
  McpServerRecord,
  McpToolInfo,
} from './types.js';
import type { McpServersChangedEvent } from './events.js';
import {
  McpInstallProvenanceSchema,
  McpServerConfigSchema,
  McpServerNameSchema,
  McpToolInfoListSchema,
} from './types.js';
import {
  McpServerConflictError,
  McpServerNotFoundError,
  McpUnsupportedTransportError,
} from './errors.js';
import {
  MAX_MCP_TOOL_SCHEMA_BYTES,
  assertMcpToolSchemaLimits,
} from './tools/toolSchemaLimits.js';

/** 不携带 tools_cache 明细的配置摘要, 用于列表查询时避免把大量 Schema 文本读入内存. */
export interface McpServerSummaryRecord {
  id: string;
  name: string;
  provenance: McpInstallProvenance;
  config: McpServerConfig;
  enabled: boolean;
  authType: McpAuthType;
  cachedToolCount: number;
}

export class McpServerStore {
  constructor(
    private readonly repo: McpServersRepo,
    private readonly onChanged?: (event: McpServersChangedEvent) => void,
  ) {}

  /** 新建服务器配置; 校验名称字符集且遇到同名记录时拒绝覆盖. */
  create(
    name: string,
    config: McpServerConfig,
    provenance: McpInstallProvenance = { sourceKind: 'manual' },
    authType?: McpAuthType,
  ): string {
    const validatedName = McpServerNameSchema.parse(name);
    const trustedProvenance = McpInstallProvenanceSchema.parse(provenance);
    if (this.repo.findByName(validatedName)) {
      throw new McpServerConflictError(validatedName);
    }

    const id = randomUUID();
    const resolvedAuthType: McpAuthType = config.type === 'http' ? (authType ?? 'none') : 'none';
    // env 和 headers 的值会以明文保存在配置 JSON 中.
    const configJson = JSON.stringify(config);
    this.repo.insert({
      id,
      name: validatedName,
      install_source: trustedProvenance.sourceKind,
      market_entry_id: trustedProvenance.sourceKind === 'official'
        ? trustedProvenance.marketEntryId
        : null,
      config_json: configJson,
      tools_cache: null,
      enabled: 1,
      auth_type: resolvedAuthType,
      installed_at: Date.now(),
    });
    this.onChanged?.({ type: 'mcp_servers_changed' });
    return id;
  }

  /** 更新已有服务器配置; provenance 未传时保留原安装来源, authType 未传时 HTTP 保留原模式. */
  update(
    name: string,
    config: McpServerConfig,
    provenance?: McpInstallProvenance,
    authType?: McpAuthType,
  ): void {
    const existing = this.repo.findByName(name);
    if (!existing) throw new McpServerNotFoundError(name);

    const trustedProvenance = provenance !== undefined
      ? McpInstallProvenanceSchema.parse(provenance)
      : undefined;
    // 未显式指定 authType 时, HTTP 服务保留原有模式, stdio 始终强制为 'none'.
    const resolvedAuthType: McpAuthType = config.type === 'http'
      ? (authType ?? existing.auth_type ?? 'none')
      : 'none';
    // env 和 headers 的值会以明文保存在配置 JSON 中.
    const configJson = JSON.stringify(config);

    this.repo.update(existing.id, {
      configJson,
      authType: resolvedAuthType,
      ...(trustedProvenance ? provenancePatch(trustedProvenance) : {}),
    });
    this.onChanged?.({ type: 'mcp_servers_changed' });
  }

  /** 缓存成功发现的工具, 供下次启动注册和离线展示使用. */
  cacheTools(name: string, tools: McpToolInfo[]): void {
    const row = this.repo.findByName(name);
    if (!row) return;
    assertMcpToolSchemaLimits(name, tools);
    this.repo.update(row.id, { toolsCache: JSON.stringify(tools) });
    this.onChanged?.({ type: 'mcp_servers_changed' });
  }

  setEnabled(name: string, enabled: boolean): void {
    const row = this.repo.findByName(name);
    if (!row) throw new McpServerNotFoundError(name);
    this.repo.update(row.id, { enabled: enabled ? 1 : 0 });
    this.onChanged?.({ type: 'mcp_servers_changed' });
  }

  setAuthType(name: string, authType: McpAuthType): void {
    const row = this.repo.findByName(name);
    if (!row) throw new McpServerNotFoundError(name);
    this.repo.update(row.id, { authType });
    this.onChanged?.({ type: 'mcp_servers_changed' });
  }

  remove(name: string): void {
    const row = this.repo.findByName(name);
    if (!row) return;
    this.repo.deleteById(row.id);
    this.onChanged?.({ type: 'mcp_servers_changed' });
  }

  findByName(name: string): McpServerRecord | null {
    const row = this.repo.findByName(name);
    return row ? this.rowToRecord(row) : null;
  }

  listSummaries(): McpServerSummaryRecord[] {
    return this.repo.listSettings().map((row) => this.rowToSummary(row));
  }

  listEnabled(): McpServerRecord[] {
    return this.repo.listEnabled().map((r) => this.rowToRecord(r));
  }

  private rowToRecord(row: McpServerRow): McpServerRecord {
    const config = parseStoredConfig(row.name, row.config_json);

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
    return {
      id:          row.id,
      name:        row.name,
      provenance:  parseProvenance(row.install_source, row.market_entry_id),
      config,
      cachedTools,
      enabled:     row.enabled === 1,
      authType:    row.auth_type ?? 'none',
    };
  }

  private rowToSummary(row: McpServerSettingsRow): McpServerSummaryRecord {
    return {
      id:              row.id,
      name:            row.name,
      provenance:      parseProvenance(row.install_source, row.market_entry_id),
      config:          parseStoredConfig(row.name, row.config_json),
      enabled:         row.enabled === 1,
      authType:        row.auth_type ?? 'none',
      cachedToolCount: row.cached_tool_count,
    };
  }
}

function parseStoredConfig(serverName: string, configJson: string): McpServerConfig {
  const rawConfig = JSON.parse(configJson) as unknown;
  if (
    rawConfig !== null &&
    typeof rawConfig === 'object' &&
    !Array.isArray(rawConfig) &&
    (rawConfig as { type?: unknown }).type === 'sse'
  ) {
    throw new McpUnsupportedTransportError(serverName, 'sse');
  }
  return McpServerConfigSchema.parse(rawConfig);
}

function parseProvenance(
  installSource: McpServerRow['install_source'],
  marketEntryId: string | null,
): McpInstallProvenance {
  return McpInstallProvenanceSchema.parse(
    installSource === 'official' && marketEntryId
      ? { sourceKind: installSource, marketEntryId }
      : { sourceKind: installSource },
  );
}

function provenancePatch(provenance: McpInstallProvenance) {
  return {
    installSource: provenance.sourceKind,
    marketEntryId: provenance.sourceKind === 'official'
      ? provenance.marketEntryId
      : null,
  };
}
