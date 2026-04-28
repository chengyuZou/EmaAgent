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

// ==========================================
// 核心视图协议 (跨边界传输用)
// ==========================================

export interface UiErrorView {
    requestId?: string; 
    traceId?: string; 
    code: UiErrorCode;
    message: string;
    severity: UiErrorSeverity;
    details?: Record<string, unknown>;
}

/** 
 * 自定义 Error 基类。
 * 所有内部明确的业务失败，都应该 throw 这个类。
 */
export class EmaError extends Error {
    constructor(
        public readonly code: UiErrorCode,
        message: string,
        public readonly retryable: boolean = false,
        public readonly details?: Record<string, unknown>,
        public readonly severity: UiErrorSeverity = "error"
    ) {
        super(message);
        this.name = "EmaError";
        // 修复 TypeScript 中继承 Error 的原型链问题
        Object.setPrototypeOf(this, EmaError.prototype); // 修复 instanceof 检测
    }
}

/** 
 * 将未知异常（或我们的 EmaError）压成 UiErrorView，供 gateway 兜底拦截器使用。
 * 建议在 Gateway 的全局 Error Handler 中调用它。
 */
export function toUiErrorView(
    error: unknown,
    traceId?: string,
    requestId?: string
): UiErrorView {
    // 1. 如果是抛出自己的已知业务错误
    if (error instanceof EmaError) {
        return {
            requestId: requestId,
            traceId: traceId,
            code: error.code,
            message: error.message,
            severity: error.severity,
            details: error.details,
        };
    }

    // 2. 其他未知错误，兜底成 internal_error
    const isError = error instanceof Error;
    return {
        requestId: requestId,
        traceId: traceId,
        code: "internal_error",
        message: isError ? error.message : "未知内部错误",
        severity: "error",
        details: {
            stack: isError ? error.stack : undefined,
            raw: String(error)
        }
    };
}