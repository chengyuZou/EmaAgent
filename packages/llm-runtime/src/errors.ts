/**
 * Provider 错误归一化。
 *
 * OpenAI、Anthropic、Gemini 等 provider 的错误体结构不同；上层 runtime 不应该
 * 直接解析这些 vendor payload。这里统一成稳定错误码，方便后续做重试、fallback、
 * UI 提示和 turns/steps 观测记录。
 */

/** Provider 统一错误码，覆盖 README 里的 V1 错误分类。 */
export type ProviderErrorCode =
  | "auth_invalid"
  | "rate_limited"
  | "quota_exceeded"
  | "model_not_found"
  | "unsupported_feature"
  | "context_overflow"
  | "network_error"
  | "timeout"
  | "provider_internal"
  | "safety_blocked"
  | "invalid_request";

export interface LlmProviderErrorOptions {
  providerId: string;
  code: ProviderErrorCode;
  status?: number;
  retryable?: boolean;
  requestId?: string;
  providerCode?: string;
  details?: unknown;
}

/** LLM Runtime 对上层暴露的标准错误。 */
export class LlmProviderError extends Error {
  readonly providerId: string;
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly providerCode?: string;
  readonly details?: unknown;

  constructor(message: string, options: LlmProviderErrorOptions) {
    super(message);
    this.name = "LlmProviderError";
    this.providerId = options.providerId;
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? isRetryableCode(options.code, options.status);
    this.requestId = options.requestId;
    this.providerCode = options.providerCode;
    this.details = options.details;
  }
}

/** 缺少 API key 时给出明确 env 名，避免把 401 当网络问题排查。 */
export function missingApiKeyError(providerId: string, envName: string): LlmProviderError {
  return new LlmProviderError(`${providerId} API key is not configured. Set ${envName} or pass apiKey in config.`, {
    providerId,
    code: "auth_invalid",
    retryable: false,
  });
}

/** HTTP 非 2xx 响应转换为标准 provider error。 */
export async function responseToProviderError(
  providerId: string,
  response: Response,
  requestId?: string,
): Promise<LlmProviderError> {
  const bodyText = await safeReadResponseText(response);
  const body = safeJsonParse(bodyText);
  const providerCode = extractProviderErrorCode(body);
  const providerMessage = extractProviderErrorMessage(body) ?? bodyText.trim();
  const message = providerMessage || `${providerId} request failed with HTTP ${response.status}.`;
  const code = classifyProviderError(response.status, providerCode, message);

  return new LlmProviderError(message, {
    providerId,
    code,
    status: response.status,
    requestId,
    providerCode,
    details: body ?? bodyText,
  });
}

/** 网络层异常转换，保留 retryable 信息给 fallback/retry 使用。 */
export function unknownToProviderError(providerId: string, error: unknown, requestId?: string): LlmProviderError {
  if (error instanceof LlmProviderError) {
    return error;
  }

  if (isAbortError(error)) {
    return new LlmProviderError(`${providerId} request timed out.`, {
      providerId,
      code: "timeout",
      requestId,
      retryable: true,
      details: error,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new LlmProviderError(`${providerId} network request failed: ${message}`, {
    providerId,
    code: "network_error",
    requestId,
    retryable: true,
    details: error,
  });
}

/** 只根据统一错误码判断是否适合自动重试。 */
export function isRetryableCode(code: ProviderErrorCode, status?: number): boolean {
  if (code === "network_error" || code === "timeout" || code === "rate_limited" || code === "provider_internal") {
    return true;
  }
  return typeof status === "number" && (status === 408 || status === 409 || status === 425 || status >= 500);
}

function classifyProviderError(status: number, providerCode: string | undefined, message: string): ProviderErrorCode {
  const normalized = `${providerCode ?? ""} ${message}`.toLowerCase();

  if (status === 401 || status === 403) {
    return "auth_invalid";
  }
  if (status === 404) {
    return "model_not_found";
  }
  if (status === 408) {
    return "timeout";
  }
  if (status === 429) {
    return normalized.includes("quota") || normalized.includes("insufficient") ? "quota_exceeded" : "rate_limited";
  }
  if (normalized.includes("context") && (normalized.includes("length") || normalized.includes("window") || normalized.includes("token"))) {
    return "context_overflow";
  }
  if (normalized.includes("safety") || normalized.includes("policy") || normalized.includes("blocked")) {
    return "safety_blocked";
  }
  if (normalized.includes("unsupported") || normalized.includes("not supported")) {
    return "unsupported_feature";
  }
  if (status >= 500) {
    return "provider_internal";
  }
  return "invalid_request";
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function safeJsonParse(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractProviderErrorMessage(body: unknown): string | undefined {
  const root = asRecord(body);
  const nested = asRecord(root?.error);
  const message = nested?.message ?? root?.message;
  return typeof message === "string" ? message : undefined;
}

function extractProviderErrorCode(body: unknown): string | undefined {
  const root = asRecord(body);
  const nested = asRecord(root?.error);
  const code = nested?.code ?? nested?.type ?? root?.code ?? root?.type;
  return typeof code === "string" ? code : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
