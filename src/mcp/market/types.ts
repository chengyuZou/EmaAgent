import type { McpServerConfig } from '../types.js';

export const MCP_MARKET_SOURCES = ['official'] as const;
export type McpMarketSource = typeof MCP_MARKET_SOURCES[number];

export interface McpMarketEntry {
  source: McpMarketSource;
  externalId: string;
  name: string;
  description: string;
  repositoryUrl?: string;
  detailUrl: string;
}

export interface McpMarketPage {
  items: McpMarketEntry[];
  total: number;
  page: number;
  pageSize: number;
  complete: boolean;
  syncing: boolean;
  refreshError?: string;
}

export interface McpMarketCatalogPage {
  items: McpMarketEntry[];
  nextCursor: string | null;
}

export interface McpMarketInstallInput {
  key: string;
  target: 'env' | 'header';
  secret: boolean;
  description?: string;
}

export interface McpMarketEntryDetail extends McpMarketEntry {
  config?: McpServerConfig;
  requiredInputs: McpMarketInstallInput[];
  unavailableReason?: string;
}

export interface McpMarketCatalog {
  readonly source: McpMarketSource;
  page(cursor?: string, signal?: AbortSignal): Promise<McpMarketCatalogPage>;
  detail(externalId: string, signal?: AbortSignal): Promise<McpMarketEntryDetail | null>;
}
