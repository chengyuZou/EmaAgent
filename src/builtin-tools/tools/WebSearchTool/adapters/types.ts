import type { WebRequest } from '@ema-agent/tools';

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface SearchOptions {
  readonly request: WebRequest;
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: SearchProgress) => void;
}

/** 查询事件保留调用方的原查询, 结果数为最终交给模型的条数. */
export type SearchProgress =
  | { readonly type: 'query_update'; readonly query: string }
  | { readonly type: 'search_results_received'; readonly query: string; readonly resultCount: number };

/**
 * 后端实现取回候选项, 不提前截断标题/摘要或裁成展示条数.
 */
export type WebSearchAdapter = (
  query: string,
  options: SearchOptions,
) => Promise<SearchResult[]>;
