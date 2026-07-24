// 描述内容搜索与文件搜索的范围、结果数量和停止原因。
export type SearchLimitReason = 'results' | 'bytes' | 'timeout';

export interface SearchPresentation {
  readonly kind: 'search';
  readonly operation: 'content_search' | 'file_search';
  readonly pattern: string;
  readonly searchPath: string;
  readonly resultCount: number;
  readonly truncated: boolean;
  readonly limitReason?: SearchLimitReason;
}

export interface CreateSearchPresentationInput {
  readonly operation: 'content_search' | 'file_search';
  readonly pattern: string;
  readonly searchPath: string;
  readonly resultCount: number;
  readonly truncated: boolean;
  readonly limitReason?: SearchLimitReason;
}

export function createSearchPresentation(
  input: CreateSearchPresentationInput,
): SearchPresentation {
  return { ...input, kind: 'search' };
}
