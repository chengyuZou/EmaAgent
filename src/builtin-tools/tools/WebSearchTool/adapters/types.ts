// WebSearch 适配层共享契约: 统一结果、选项、进度事件与后端实现签名。

/** 搜索后端的 HTTP 状态错误(供 formatProviderError 翻译成可操作提示)。 */
export class SearchHttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'SearchHttpStatusError';
  }
}

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface SearchOptions {
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: SearchProgress) => void;
}

/** 与 Claude 对齐的两态进度; 查询更新在发请求前, 结果数在过滤/归一之后。 */
export type SearchProgress =
  | { readonly type: 'query_update'; readonly query: string }
  | { readonly type: 'search_results_received'; readonly query: string; readonly resultCount: number };

/**
 * 后端实现只负责取回原始结果; 域名过滤、URL 归一、去重与截断
 * 由适配层统一完成, 三个后端不各自实现。
 */
export type WebSearchAdapter = (
  query: string,
  options: SearchOptions,
) => Promise<SearchResult[]>;
