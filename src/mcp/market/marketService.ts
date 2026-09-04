import type { McpRegistry } from '../registry.js';
import type { McpServerConfig } from '../types.js';
import type { McpMarketCatalog, McpMarketEntry, McpMarketEntryDetail, McpMarketPage, McpMarketSource } from './types.js';
import type { McpMarketStore } from './marketStore.js';

const MCP_MARKET_PAGE_SIZE = 40;

export class McpMarketService {
  private refreshErrors = new Map<McpMarketSource, string>();
  private catalogs: Map<McpMarketSource, McpMarketCatalog>;
  private activeSyncs = new Map<McpMarketSource, Promise<void>>();
  private initialLoads = new Map<McpMarketSource, Promise<void>>();
  private refreshedThisProcess = new Set<McpMarketSource>();

  constructor(
    private readonly store: McpMarketStore,
    catalogs: readonly McpMarketCatalog[],
    private readonly mcp: Pick<McpRegistry, 'save'>,
    private readonly changed: (source: McpMarketSource) => void,
  ) {
    this.catalogs = new Map(catalogs.map(catalog => [catalog.source, catalog]));
  }

  async load(source: McpMarketSource, query: string, page: number, signal?: AbortSignal): Promise<McpMarketPage> {
    let state = this.store.fetchState(source);
    if (!state) {
      try {
        await this.ensureFirstPage(source, signal);
        state = this.store.fetchState(source);
      } catch (error) {
        return {
          items: [], total: 0, page: 1, pageSize: MCP_MARKET_PAGE_SIZE,
          complete: false,
          syncing: false,
          refreshError: messageOf(error),
        };
      }
    }
    if (state?.nextCursor) this.continuePartialSync(source, state.nextCursor);
    else if (state) this.refreshCompleteCacheInBackground(source);

    const result = this.store.listPage(source, query, page, MCP_MARKET_PAGE_SIZE);
    const refreshError = this.refreshErrors.get(source);
    const currentState = this.store.fetchState(source);
    return {
      ...result,
      complete: currentState?.nextCursor === null,
      syncing: this.activeSyncs.has(source),
      ...(refreshError ? { refreshError } : {}),
    };
  }

  async refresh(source: McpMarketSource, signal?: AbortSignal): Promise<number> {
    const active = this.activeSyncs.get(source);
    if (active) {
      await active;
      return this.store.listPage(source, '', 1, 1).total;
    }

    const task = this.replaceFromAllPages(source, signal);
    this.activeSyncs.set(source, task);
    try {
      await task;
      return this.store.listPage(source, '', 1, 1).total;
    } catch (error) {
      this.refreshErrors.set(source, messageOf(error));
      this.changed(source);
      throw error;
    } finally {
      if (this.activeSyncs.get(source) === task) this.activeSyncs.delete(source);
    }
  }

  detail(source: McpMarketSource, externalId: string, signal?: AbortSignal): Promise<McpMarketEntryDetail | null> {
    return this.catalog(source).detail(externalId, signal);
  }

  async install(input: {
    source: McpMarketSource;
    externalId: string;
    name?: string;
    inputs?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<{ id: string; name: string }> {
    const detail = await this.detail(input.source, input.externalId, input.signal);
    if (!detail) throw new Error('MCP 市场条目不存在.');
    if (!detail.config) throw new Error(detail.unavailableReason ?? 'MCP 市场条目不可安装.');
    const values = input.inputs ?? {};
    const missing = detail.requiredInputs.filter(item => !values[item.key]?.trim()).map(item => item.key);
    if (missing.length) throw new Error(`缺少安装参数: ${missing.join(', ')}`);
    const config = applyInputs(detail.config, detail.requiredInputs, values);
    const name = input.name?.trim() || detail.name;
    const id = await this.mcp.save(name, config, provenance(input.source, input.externalId));
    return { id, name };
  }

  private catalog(source: McpMarketSource): McpMarketCatalog {
    const catalog = this.catalogs.get(source);
    if (!catalog) throw new Error(`MCP 市场来源未接入: ${source}`);
    return catalog;
  }

  private ensureFirstPage(source: McpMarketSource, signal?: AbortSignal): Promise<void> {
    const active = this.initialLoads.get(source);
    if (active) return active;

    const task = (async () => {
      const page = await this.catalog(source).page(undefined, signal);
      this.store.appendPage(source, page.items, page.nextCursor);
      this.refreshErrors.delete(source);
      this.changed(source);
      if (page.nextCursor) this.continuePartialSync(source, page.nextCursor);
      else this.refreshedThisProcess.add(source);
    })();
    this.initialLoads.set(source, task);
    void task.finally(() => {
      if (this.initialLoads.get(source) === task) this.initialLoads.delete(source);
    }).catch(() => {});
    return task;
  }

  private continuePartialSync(source: McpMarketSource, firstCursor: string): void {
    if (this.activeSyncs.has(source)) return;
    const task = this.appendRemainingPages(source, firstCursor);
    this.activeSyncs.set(source, task);
    void task.catch(error => {
      this.refreshErrors.set(source, messageOf(error));
      this.changed(source);
    }).finally(() => {
      if (this.activeSyncs.get(source) === task) this.activeSyncs.delete(source);
    });
  }

  private refreshCompleteCacheInBackground(source: McpMarketSource): void {
    if (this.refreshedThisProcess.has(source)) return;
    this.refreshedThisProcess.add(source);
    void this.refresh(source).catch(() => {});
  }

  private async appendRemainingPages(source: McpMarketSource, firstCursor: string): Promise<void> {
    const catalog = this.catalog(source);
    let cursor: string | null = firstCursor;
    while (cursor) {
      const requestedCursor: string = cursor;
      const page = await catalog.page(requestedCursor);
      if (page.nextCursor === requestedCursor) throw new Error('Official MCP Registry 返回了重复 cursor.');
      this.store.appendPage(source, page.items, page.nextCursor);
      this.refreshErrors.delete(source);
      this.changed(source);
      cursor = page.nextCursor;
    }
    this.refreshedThisProcess.add(source);
  }

  private async replaceFromAllPages(source: McpMarketSource, signal?: AbortSignal): Promise<void> {
    const catalog = this.catalog(source);
    const entries = new Map<string, McpMarketEntry>();
    let cursor: string | null = null;
    do {
      const requestedCursor: string | null = cursor;
      const page = await catalog.page(cursor ?? undefined, signal);
      for (const entry of page.items) entries.set(entry.externalId, entry);
      if (page.nextCursor !== null && page.nextCursor === requestedCursor) {
        throw new Error('Official MCP Registry 返回了重复 cursor.');
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.store.replace(source, [...entries.values()]);
    this.refreshErrors.delete(source);
    this.refreshedThisProcess.add(source);
    this.changed(source);
  }
}

function provenance(source: McpMarketSource, marketEntryId: string) {
  switch (source) {
    case 'official': return { sourceKind: 'official' as const, marketEntryId };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyInputs(
  config: McpServerConfig,
  required: readonly McpMarketEntryDetail['requiredInputs'][number][],
  values: Record<string, string>,
): McpServerConfig {
  if (config.type === 'http') {
    const headers = { ...config.headers };
    for (const item of required) if (item.target === 'header') headers[item.key] = values[item.key]!;
    return { ...config, ...(Object.keys(headers).length ? { headers } : {}) };
  }
  const env = { ...config.env };
  for (const item of required) if (item.target === 'env') env[item.key] = values[item.key]!;
  return { ...config, ...(Object.keys(env).length ? { env } : {}) };
}
