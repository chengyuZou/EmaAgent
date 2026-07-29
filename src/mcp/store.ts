// MCP 存储入口负责服务器配置与工具缓存的持久化转换和运行时校验。
import { Buffer }                  from 'node:buffer';
import { randomUUID }            from 'node:crypto';
import type { McpServersRepo }   from '@ema-agent/storage';
import type { McpInstallProvenance, McpServerConfig, McpServerRecord, McpToolInfo } from './types.js';
import { McpInstallProvenanceSchema, McpServerConfigSchema, McpToolInfoListSchema } from './types.js';
import { McpServerNotFoundError, McpUnsupportedTransportError } from './errors.js';
import { buildLockedPackageLaunch } from './market/package-spec.js';
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
//   - 用领域类型(非裸 DB 行)表达 CRUD
//
// 不管连接 - 那是 McpRegistry 的事。

export class McpServerStore {
  constructor(private readonly repo: McpServersRepo) {}

  register(
    name: string,
    config: McpServerConfig,
    sourceUrl?: string,
    provenance: McpInstallProvenance = { sourceKind: 'manual' },
  ): string {
    const trustedProvenance = McpInstallProvenanceSchema.parse(provenance);
    assertMarketPackageLock(config, trustedProvenance);
    const existing = this.repo.findByName(name);
    if (existing) {
      this.repo.update(existing.id, {
        configJson: JSON.stringify(config),
        sourceUrl:  sourceUrl ?? null,
        ...provenancePatch(trustedProvenance),
      });
      return existing.id;
    }
    const id = randomUUID();
    this.repo.insert({
      id,
      name,
      source_url:   sourceUrl ?? null,
      install_source: trustedProvenance.sourceKind,
      market_source_id: trustedProvenance.marketSourceId ?? null,
      market_source_type: trustedProvenance.marketSourceType ?? null,
      package_registry: trustedProvenance.packageRegistry ?? null,
      package_name: trustedProvenance.packageName ?? null,
      package_version: trustedProvenance.packageVersion ?? null,
      package_integrity: trustedProvenance.packageIntegrity ?? null,
      config_json:  JSON.stringify(config),
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

  // ── 私有 ──────────────────────────────────────────────────────────────

  private rowToRecord(row: {
    id: string; name: string; source_url: string | null;
    install_source?: 'manual' | 'import' | 'market';
    market_source_id?: string | null; market_source_type?: string | null;
    package_registry?: string | null; package_name?: string | null;
    package_version?: string | null; package_integrity?: string | null;
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
    const parsedProvenance = McpInstallProvenanceSchema.safeParse({
      sourceKind: row.install_source ?? 'manual',
      ...(row.market_source_id ? { marketSourceId: row.market_source_id } : {}),
      ...(row.market_source_type ? { marketSourceType: row.market_source_type } : {}),
      ...(row.package_registry === 'npm' || row.package_registry === 'pypi'
        ? { packageRegistry: row.package_registry }
        : {}),
      ...(row.package_name ? { packageName: row.package_name } : {}),
      ...(row.package_version ? { packageVersion: row.package_version } : {}),
      ...(row.package_integrity ? { packageIntegrity: row.package_integrity } : {}),
    });
    return {
      id:          row.id,
      name:        row.name,
      sourceUrl:   row.source_url ?? undefined,
      // 损坏或旧版不完整 provenance 降级为 manual，绝不虚报“市场版本已锁定”。
      provenance: parsedProvenance.success
        ? parsedProvenance.data
        : { sourceKind: 'manual' },
      config:      McpServerConfigSchema.parse(rawConfig),
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
    marketSourceId: provenance.marketSourceId ?? null,
    marketSourceType: provenance.marketSourceType ?? null,
    packageRegistry: provenance.packageRegistry ?? null,
    packageName: provenance.packageName ?? null,
    packageVersion: provenance.packageVersion ?? null,
    packageIntegrity: provenance.packageIntegrity ?? null,
  };
}

function assertMarketPackageLock(
  config: McpServerConfig,
  provenance: McpInstallProvenance,
): void {
  if (provenance.sourceKind !== 'market' || config.type !== 'stdio') return;
  const command = config.command.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
  if (command !== 'npx' && command !== 'npx.cmd' && command !== 'uvx' && command !== 'uvx.exe') {
    return;
  }
  if (!provenance.packageRegistry || !provenance.packageName || !provenance.packageVersion) {
    throw new Error('Market package MCP config requires explicit registry, package name and exact version');
  }
  const lockedLaunch = buildLockedPackageLaunch(
    provenance.packageRegistry,
    provenance.packageName,
    provenance.packageVersion,
  );
  if (!lockedLaunch) {
    throw new Error('Market package MCP config requires a valid package name and exact version');
  }
  if (!command.startsWith(lockedLaunch.command) || !sameStrings(config.args, lockedLaunch.args)) {
    throw new Error('Market package MCP launch config does not match its locked package provenance');
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
