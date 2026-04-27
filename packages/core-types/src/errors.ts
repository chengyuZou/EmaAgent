/**
 * UI 可理解的错误协议。
 *
 * Runtime 内部可以继续使用业务异常类；跨 API / SSE 边界时统一落到
 * UiErrorView，避免前端直接依赖某个包里的 Error 子类。
 */

/** V1 文档中定义的稳定错误码集合。 */
export type UiErrorCode =
  | "provider_unavailable"
  | "model_not_found"
  | "model_capability_mismatch"
  | "rate_limited"
  | "context_overflow"
  | "tool_denied"
  | "tool_failed"
  | "sandbox_denied"
  | "permission_required"
  | "bridge_unavailable"
  | "session_not_found"
  | "artifact_not_found"
  | "storage_migration_failed"
  | "bad_request"
  | "internal_error";

/** 前端决定提示样式与是否展示重试按钮时使用的严重级别。 */
export type UiErrorSeverity = "info" | "warning" | "error";

/** API 与事件流中统一传输的错误视图。 */
export interface UiErrorView {
  /** 机器可读错误码。 */
  code: UiErrorCode;
  /** 人类可读消息，前端可直接展示。 */
  message: string;
  /** 是否建议前端展示重试入口。 */
  retryable: boolean;
  /** 错误严重级别。 */
  severity: UiErrorSeverity;
  /** 可选详情，通常只在 developer inspector 中展示。 */
  details?: Record<string, unknown>;
}

/** 将未知异常压成默认内部错误，供 gateway 兜底使用。 */
export function toInternalUiError(error: unknown): UiErrorView {
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : "Unknown internal error.",
    retryable: false,
    severity: "error",
  };
}
