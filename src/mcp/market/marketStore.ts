import type { McpMarketEntriesRepo, McpMarketEntryRow } from '@ema-agent/storage';
import type { McpMarketEntry, McpMarketSource } from './types.js';

export class McpMarketStore {
  constructor(private readonly repo: McpMarketEntriesRepo) {}

  replace(source: McpMarketSource, entries: readonly McpMarketEntry[]): void {
    this.repo.replaceSource(source, entries.map(toRow));
  }

  appendPage(source: McpMarketSource, entries: readonly McpMarketEntry[], nextCursor: string | null): void {
    this.repo.appendPage(source, entries.map(toRow), nextCursor);
  }

  fetchState(source: McpMarketSource): { nextCursor: string | null } | null {
    const state = this.repo.fetchState(source);
    return state ? { nextCursor: state.next_cursor } : null;
  }

  listPage(source: McpMarketSource, query: string, page: number, pageSize: number) {
    const requestedPage = Math.max(1, page);
    const first = this.repo.listPage(source, query, (requestedPage - 1) * pageSize, pageSize);
    const lastPage = Math.max(1, Math.ceil(first.total / pageSize));
    const actualPage = Math.min(requestedPage, lastPage);
    const result = actualPage === requestedPage
      ? first
      : this.repo.listPage(source, query, (actualPage - 1) * pageSize, pageSize);
    return {
      items: result.rows.map(fromRow),
      total: result.total,
      page: actualPage,
      pageSize,
    };
  }

}

function toRow(entry: McpMarketEntry): McpMarketEntryRow {
  return {
    source: entry.source,
    external_id: entry.externalId,
    name: entry.name,
    description: entry.description,
    repository_url: entry.repositoryUrl ?? null,
    detail_url: entry.detailUrl,
  };
}

function fromRow(row: McpMarketEntryRow): McpMarketEntry {
  return {
    source: row.source as McpMarketSource,
    externalId: row.external_id,
    name: row.name,
    description: row.description,
    ...(row.repository_url ? { repositoryUrl: row.repository_url } : {}),
    detailUrl: row.detail_url,
  };
}
