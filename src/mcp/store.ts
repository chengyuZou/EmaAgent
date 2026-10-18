import { Buffer }                from 'node:buffer';
import { randomUUID }            from 'node:crypto';
import type { McpServersRepo, McpServerRow, McpServerSettingsRow } from '@ema-agent/storage';
import type { McpInstallProvenance, McpServerConfig, McpServerRecord, McpToolInfo } from './types.js';
import type { McpServersChangedEvent } from './events.js';
import { McpInstallProvenanceSchema, McpServerConfigSchema, McpToolInfoListSchema } from './types.js';
import { McpServerNotFoundError, McpUnsupportedTransportError } from './errors.js';
import {
  MAX_MCP_TOOL_SCHEMA_BYTES,
  assertMcpToolSchemaLimits,
} from './toolSchemaLimits.js';

interface McpServerSettings {
  name: string;
  provenance: McpInstallProvenance;
  config: McpServerConfig;
  enabled: boolean;
  cachedToolCount: number;
}

export class McpServerStore {
  constructor(
    private readonly repo: McpServersRepo,
    private readonly onChanged?: (event: McpServersChangedEvent) => void,
  ) {}

  register(
    name: string,
    config: McpServerConfig,
    provenance: McpInstallProvenance = { sourceKind: 'manual' },
  ): string {
    const trustedProvenance = McpInstallProvenanceSchema.parse(provenance);
    const existing = this.repo.findByName(name);
    // 同名更新沿用记录 id, 市场来源随本次保存一起更新.
    const id = existing?.id ?? randomUUID();
    // env 和 headers 的值会以明文保存在配置 JSON 中.
    const configJson = JSON.stringify(config);
    if (existing) {
      this.repo.update(existing.id, {
        configJson,
        ...provenancePatch(trustedProvenance),
      });
      this.onChanged?.({ type: 'mcp_servers_changed' });
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
    this.onChanged?.({ type: 'mcp_servers_changed' });
    return id;
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

  listSettings(): McpServerSettings[] {
    return this.repo.listSettings().map((row) => this.rowToSettings(row));
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
    return {
      id:          row.id,
      name:        row.name,
      provenance: parseProvenance(row.install_source, row.market_entry_id),
      config:      McpServerConfigSchema.parse(rawConfig),
      cachedTools,
      enabled:     row.enabled === 1,
    };
  }

  private rowToSettings(row: McpServerSettingsRow): McpServerSettings {
    return {
      name: row.name,
      provenance: parseProvenance(row.install_source, row.market_entry_id),
      config: McpServerConfigSchema.parse(JSON.parse(row.config_json) as unknown),
      enabled: row.enabled === 1,
      cachedToolCount: row.cached_tool_count,
    };
  }
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
