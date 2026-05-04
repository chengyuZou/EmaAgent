/**
 * HTTP / 网络常量 — 状态码、可重试码、API 版本、错误模式。
 */

// ═══════════════════════════════════════════════════════════════
// HTTP 状态码
// ═══════════════════════════════════════════════════════════════

export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const

/** 可自动重试的 HTTP 状态码集合。 */
export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([
  408, // Request Timeout
  409, // Conflict
  425, // Too Early
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
])

/** 判断 HTTP 状态码是否可重试（>=500 的服务端错误也可重试）。 */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500
}

// ═══════════════════════════════════════════════════════════════
// Provider API 版本
// ═══════════════════════════════════════════════════════════════

export const API_VERSIONS = {
  anthropic: "2023-06-01",
} as const

// ═══════════════════════════════════════════════════════════════
// 错误分类模式
// ═══════════════════════════════════════════════════════════════

/** 认证/鉴权错误的关键词模式。 */
export const AUTH_ERROR_PATTERNS = ["401", "auth", "unauthorized", "invalid key", "invalid api key"]

/** 速率限制错误的关键词模式。 */
export const RATE_LIMIT_ERROR_PATTERNS = ["429", "rate", "quota", "capacity", "overloaded"]

/** 模型不存在/不可用的关键词模式。 */
export const MODEL_ERROR_PATTERNS = ["model", "not found", "not available", "deployment"]

// ═══════════════════════════════════════════════════════════════
// 本地服务端口
// ═══════════════════════════════════════════════════════════════

/** Fastify BFF 默认端口。 */
export const BFF_PORT = 3421

/** Python compute bridge 默认端口。 */
export const PYTHON_BRIDGE_PORT = 3422

/** Edge TTS 本地服务默认端口。 */
export const EDGE_TTS_PORT = 3423
