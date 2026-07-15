// ── KB 错误类型 ──────────────────────────────────────────────────────────────
//
// 仿 vision/errors.ts：集中列举 embed 路径上所有可能出现的错误，
// 统一 code 命名空间 `kb/...` + retryable 标记，供 semantic chunker / ingest
// 共用。把任意 unknown error 经 classifyKbError 归一成 KbError，调用方不再猜字符串。

/** KB 错误码。当前覆盖 embed 路径；parse/read/检索错误待后续按需扩充。 */
export type KbErrorCode =
  | 'kb/not_configured'              // 未配置 embedding provider/model
  | 'kb/invalid_request'             // 参数非法(batchSize≤0、空文本等)
  | 'kb/embed_aborted'               // 用户或上游取消
  | 'kb/embed_timeout'               // 单批 embed 超时
  | 'kb/embed_auth_failed'           // 401/403 鉴权失败
  | 'kb/embed_rate_limited'          // 429 限流
  | 'kb/embed_provider_unavailable'  // 5xx / 网络中断 / DNS
  | 'kb/embed_space_mismatch'        // embedding space 跨空间(预留,ingest 用)
  | 'kb/embed_count_mismatch'        // 返回向量数 ≠ 输入数(预留,ingest 用)
  | 'kb/embed_invalid_vector'        // 维度漂移 / 非有限值(预留,ingest 用)
  | 'kb/embed_batch_failed'          // 重试耗尽
  | 'kb/embed_failed';               // 兜底,未知 provider 错误

/** 随错误携带的元数据。retryable 决定 embedWithRetry 是否退避重试。 */
export interface KbErrorMeta {
  providerId?: string;
  model?: string;
  /** 语义分块时的 batch 序号,便于定位失败批次。 */
  batchIndex?: number;
  retryable?: boolean;
  status?: number;
  context?: unknown;
}

export class KbError extends Error {
  readonly code: KbErrorCode;
  readonly details?: unknown;
  readonly meta: KbErrorMeta;

  constructor(
    code: KbErrorCode,
    message: string,
    options: { cause?: unknown; details?: unknown; meta?: KbErrorMeta } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KbError';
    this.code = code;
    this.details = options.details;
    this.meta = options.meta ?? {};
  }
}

export function isKbError(error: unknown): error is KbError {
  return error instanceof KbError;
}

/**
 * 把任意 unknown error 归一成 KbError。按 HTTP status / 关键词路由,
 * 集中判定 retryable。已是 KbError 的原样透传。
 *
 * @param timedOut 调用方已知是否超时(embedWithRetry 用 setTimeout 触发 abort 时置 true)。
 */
export function classifyKbError(
  error: unknown,
  meta: KbErrorMeta = {},
  timedOut = false,
): KbError {
  if (error instanceof KbError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const status = httpStatus(error);
  const lower = message.toLowerCase();

  if (timedOut) {
    return new KbError('kb/embed_timeout', 'Embedding request timed out', {
      cause: error,
      meta: { ...meta, retryable: true },
    });
  }

  if (isAbortError(error) || lower.includes('abort')) {
    return new KbError('kb/embed_aborted', 'Embedding request was aborted', {
      cause: error,
      meta: { ...meta, retryable: false },
    });
  }

  // embedding space / 数量 / 维度类(ingest 内部抛出,关键词匹配)
  if (lower.includes('embedding space changed') || lower.includes('space changed')) {
    return new KbError('kb/embed_space_mismatch', message, {
      cause: error, meta: { ...meta, status, retryable: false },
    });
  }
  if (lower.includes('count mismatch')) {
    return new KbError('kb/embed_count_mismatch', message, {
      cause: error, meta: { ...meta, status, retryable: false },
    });
  }
  if (lower.includes('invalid embedding vector') || lower.includes('empty vector')) {
    return new KbError('kb/embed_invalid_vector', message, {
      cause: error, meta: { ...meta, status, retryable: false },
    });
  }

  if (status === 401 || status === 403 || lower.includes('api_key_invalid') || lower.includes('auth_failed')) {
    return new KbError('kb/embed_auth_failed', message, {
      cause: error, meta: { ...meta, status, retryable: false },
    });
  }

  if (status === 429 || lower.includes('rate_limit') || lower.includes('too many requests')) {
    return new KbError('kb/embed_rate_limited', message, {
      cause: error, meta: { ...meta, status, retryable: true },
    });
  }

  if (
    status === 408
    || (status !== undefined && status >= 500)
    || lower.includes('timeout')
    || lower.includes('econnreset')
    || lower.includes('enotfound')
    || lower.includes('network')
    || lower.includes('fetch failed')
  ) {
    return new KbError('kb/embed_provider_unavailable', message, {
      cause: error, meta: { ...meta, status, retryable: true },
    });
  }

  return new KbError('kb/embed_failed', message, {
    cause: error, meta: { ...meta, status, retryable: false },
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const status = record['status'] ?? record['statusCode'];
  return typeof status === 'number' ? status : undefined;
}
