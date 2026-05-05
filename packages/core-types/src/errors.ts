/**
 * 跨边界错误协议。
 *
 * ## 设计原则
 *
 * 后端内部可以使用任意业务异常类（如 `TurnLockError`、`ProviderTimeoutError`），
 * 但跨越 API / SSE 边界时，必须统一归一化为 `UiErrorView`。
 * 前端只消费 `UiErrorView`，不依赖任何后端包内部的 Error 子类。
 *
 * ## 错误码命名规范
 *
 * - 使用 snake_case，描述"发生了什么"而非"在哪个模块发生"
 * - 新增 code 时必须同时确认前端是否已有对应的 UI 文案和重试策略
 */

import type { RequestId } from "./ids.js"

// ═══════════════════════════════════════════════════════════════
// 错误码
// ═══════════════════════════════════════════════════════════════

/** 稳定错误码——前后端共享的"错误语言"。 */
export type UiErrorCode =
  // --- Provider / Model ---
  | "provider_unavailable"
  | "model_not_found"
  | "model_capability_mismatch"
  | "rate_limited"
  | "context_overflow"

  // --- Agent 工具链 ---
  | "tool_denied"
  | "tool_failed"
  | "tool_timeout"
  | "tool_not_found"
  | "sandbox_denied"
  | "permission_required"

  // --- Agent 执行 ---
  | "react_max_steps"
  | "react_error_loop"
  | "react_aborted"

  // --- Bridge ---
  | "bridge_unavailable"
  | "bridge_timeout"

  // --- Session / Turn ---
  | "session_not_found"
  | "turn_not_found"
  | "turn_in_progress"
  | "turn_cancelled"

  // --- Artifact ---
  | "artifact_not_found"

  // --- Storage ---
  | "storage_migration_failed"

  // --- 通用 ---
  | "bad_request"
  | "internal_error"
  | "unknown_error"

// ═══════════════════════════════════════════════════════════════
// 严重级别
// ═══════════════════════════════════════════════════════════════

/**
 * UI 错误严重级别——前端据此决定提示样式和是否显示重试按钮。
 *
 * - `info`: 蓝色提示条，自动消失，无重试
 * - `warning`: 黄色警告条，不自动消失，可选重试
 * - `error`: 红色错误条，显示重试按钮
 */
export type UiErrorSeverity = "info" | "warning" | "error"

// ═══════════════════════════════════════════════════════════════
// 视图协议
// ═══════════════════════════════════════════════════════════════

/** 跨 API / SSE 边界传输的标准化错误视图。前端只消费此结构。 */
export interface UiErrorView {
  /** 关联的 API 请求 ID（可选，SSE 流内错误可能无 requestId）。 */
  requestId?: RequestId
  /** 全链路追踪 ID（可选，前端可复制到剪贴板供调试）。 */
  traceId?: string
  code: UiErrorCode
  message: string
  severity: UiErrorSeverity
  /** 附加上下文——如失败的 tool name、超时毫秒数等。 */
  details?: Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════
// 异常类
// ═══════════════════════════════════════════════════════════════

/**
 * EmaAgent 统一业务异常。
 *
 * ## 使用方式
 *
 * ```ts
 * throw new EmaError("tool_denied", `拒绝执行 ${name}`, false, { toolName: name })
 * ```
 *
 * ## 为什么不继承标准 Error 的 name？
 *
 * `Object.setPrototypeOf` 确保 `instanceof EmaError` 在 ES5 编译目标下仍正确工作。
 */
export class EmaError extends Error {
  constructor(
    public readonly code: UiErrorCode,
    message: string,
    public readonly retryable: boolean = false,
    public readonly details?: Record<string, unknown>,
    public readonly severity: UiErrorSeverity = "error",
  ) {
    super(message)
    this.name = "EmaError"
    // ES5 兼容：确保 instanceof 正确
    Object.setPrototypeOf(this, EmaError.prototype)
  }
}

// ═══════════════════════════════════════════════════════════════
// 归一化
// ═══════════════════════════════════════════════════════════════

/**
 * 将任意异常归一化为 UiErrorView。
 *
 * ## 调用位置
 *
 * - Fastify `setErrorHandler`（所有未捕获异常的兜底）
 * - SSE 流内 `catch` 块（将异常包装为 ErrorEvent 推入流）
 * - turn 后台任务 `failBackgroundTurn`（将异常落盘为 TurnRecord.errorCode）
 */
export function toUiErrorView(
  error: unknown,
  traceId?: string,
  requestId?: RequestId,
): UiErrorView {
  if (error instanceof EmaError) {
    return {
      requestId,
      traceId,
      code: error.code,
      message: error.message,
      severity: error.severity,
      details: error.details,
    }
  }

  // 非 EmaError 的异常统一归类为 internal_error
  const isError = error instanceof Error
  return {
    requestId,
    traceId,
    code: "internal_error",
    message: isError ? error.message : "Unknown internal error",
    severity: "error",
    details: {
      stack: isError ? error.stack : undefined,
      raw: String(error),
    },
  }
}
