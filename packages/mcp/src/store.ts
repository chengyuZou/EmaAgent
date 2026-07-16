// 这里管理 MCP 服务器配置与工具缓存的持久化转换和运行时校验。
import { randomUUID }            from 'node:crypto';
import type { McpServersRepo }   from '@ema-agent/storage';
import type { McpServerConfig, McpServerRecord, McpToolInfo } from './types.js';
import { McpServerConfigSchema, McpToolInfoListSchema } from './types.js';
import { McpServerNotFoundError, McpUnsupportedTransportError } from './errors.js';

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

  register(name: string, config: McpServerConfig, sourceUrl?: string): string {
    const existing = this.repo.findByName(name);
    if (existing) {
      this.repo.update(existing.id, {
        configJson: JSON.stringify(config),
        sourceUrl:  sourceUrl ?? null,
      });
      return existing.id;
    }
    const id = randomUUID();
    this.repo.insert({
      id,
      name,
      source_url:   sourceUrl ?? null,
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
    if (row.tools_cache) {
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
      sourceUrl:   row.source_url ?? undefined,
      config:      McpServerConfigSchema.parse(rawConfig),
      cachedTools,
      cachedAt:    row.cached_at ?? 0,
      enabled:     row.enabled === 1,
      installedAt: row.installed_at,
    };
  }
}
