// 汇总 rerank 稳定错误码与错误类型：usage 记录、重试与探测统一从这里取码。

export type RerankErrorCode =
  | 'rerank/not_configured'
  | 'rerank/duplicate_config'
  | 'rerank/invalid_top_k'
  | 'rerank/base_url_required'
  | 'rerank/http_error'
  | 'rerank/too_many_results'
  | 'rerank/invalid_index'
  | 'rerank/duplicate_index'
  | 'rerank/invalid_score'
  | 'rerank/missing_score'
  | 'rerank/timeout'
  | 'rerank/aborted'
  | 'rerank/provider_failed'
  | 'rerank/probe_failed'
  | 'rerank/probe_cancelled'
  | 'rerank/auth_failed'
  | 'rerank/model_not_found'
  | 'rerank/rate_limited'
  | 'rerank/unavailable';

/** rerank 域内统一错误：code 供 usage/重试读取，status 保留 HTTP 语义。 */
export class RerankError extends Error {
  readonly code: RerankErrorCode;
  readonly status?: number;

  constructor(
    code: RerankErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'RerankError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}
