// mcp_registry_sources 的业务层:行映射、CRUD 与内置官方源种子。
import { randomUUID } from 'node:crypto';
import type { McpRegistrySourcesRepo, McpRegistrySourceRow } from '@ema-agent/storage';
import type { McpRegistrySource } from './types.js';

export const OFFICIAL_REGISTRY_SEED = {
  id: 'official-mcp-registry',
  label: 'MCP 官方 Registry',
  registryUrl: 'https://registry.modelcontextprotocol.io/v0/servers',
} as const;

export class McpRegistrySourceStore {
  constructor(private readonly repo: McpRegistrySourcesRepo) {}

  /** 启动时确保官方源存在(builtin,禁删);用户删不掉,只可能禁用。 */
  ensureOfficialSeed(): void {
    if (this.repo.findById(OFFICIAL_REGISTRY_SEED.id)) return;
    const now = Date.now();
    this.repo.insert({
      id: OFFICIAL_REGISTRY_SEED.id,
      label: OFFICIAL_REGISTRY_SEED.label,
      registry_url: OFFICIAL_REGISTRY_SEED.registryUrl,
      builtin: 1,
      sort_order: 0,
      created_at: now,
      updated_at: now,
    });
  }

  add(label: string, registryUrl: string): McpRegistrySource {
    const now = Date.now();
    const id = randomUUID();
    this.repo.insert({
      id,
      label,
      registry_url: registryUrl,
      builtin: 0,
      sort_order: this.repo.listAll().length,
      created_at: now,
      updated_at: now,
    });
    return rowToSource(this.repo.findById(id)!);
  }

  update(id: string, patch: { label?: string; registryUrl?: string; enabled?: boolean }): void {
    this.repo.update(id, {
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.registryUrl !== undefined ? { registry_url: patch.registryUrl } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
      updated_at: Date.now(),
    });
  }

  /** 内置源拒删,返回 false。 */
  remove(id: string): boolean {
    return this.repo.deleteById(id);
  }

  list(): McpRegistrySource[] {
    return this.repo.listAll().map(rowToSource);
  }

  listEnabled(): McpRegistrySource[] {
    return this.repo.listEnabled().map(rowToSource);
  }

  get(id: string): McpRegistrySource | null {
    const row = this.repo.findById(id);
    return row ? rowToSource(row) : null;
  }
}

function rowToSource(row: McpRegistrySourceRow): McpRegistrySource {
  return {
    id: row.id,
    label: row.label,
    registryUrl: row.registry_url,
    enabled: row.enabled === 1,
    builtin: row.builtin === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
