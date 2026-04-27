/**
 * 全局业务错误码定义。
 *
 * 所有跨 runtime 抛出的异常必须使用这里的错误码，
 * 方便 Gateway 统一映射 HTTP 状态码与前端提示文案。
 */
export const ErrorCode = {
  /** LLM 调用超时，建议上层做指数退避重试 */
  LLM_TIMEOUT: "LLM_TIMEOUT",

  /** 触发 Provider 限流，需要等待后重试 */
  LLM_RATE_LIMIT: "LLM_RATE_LIMIT",

  /** 权限引擎明确拒绝此次工具调用 */
  TOOL_REJECTED: "TOOL_REJECTED",

  /** 工具执行过程中抛出异常 */
  TOOL_EXECUTION_FAILED: "TOOL_EXECUTION_FAILED",

  /** 沙箱策略拦截了高危操作 */
  SANDBOX_DENIED: "SANDBOX_DENIED",

  /** 召回结果为空，属于正常降级而非错误 */
  RECALL_EMPTY: "RECALL_EMPTY",

  /** Python Compute Bridge 不可用，已触发降级逻辑 */
  BRIDGE_UNAVAILABLE: "BRIDGE_UNAVAILABLE",

  /** 目标会话不存在 */
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",

  /** 配置校验失败 */
  CONFIG_INVALID: "CONFIG_INVALID",

  /** 参数校验失败 */
  PARAM_INVALID: "PARAM_INVALID",
} as const;

/**
 * 错误码联合类型，用于类型收窄。
 */
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Ema 业务异常基类。
 *
 * @remarks
 * 所有 runtime 内部异常必须包裹为此类，携带 `code` 与 `retryable`，
 * 让 Gateway 的 error-handler 插件能统一决定是否返回 503（可重试）。
 */
export class EmaError extends Error {
  readonly code: ErrorCodeType;
  readonly retryable: boolean;

  /**
   * @param code - 错误码，取自 {@link ErrorCode}
   * @param message - 人类可读描述
   * @param retryable - 调用方是否应该重试
   */
  constructor(code: ErrorCodeType, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.name = "EmaError";
    // Fix prototype chain for instanceof checks
    Object.setPrototypeOf(this, EmaError.prototype);
  }
}

/**
 * 类型守卫：判断未知值是否为 {@link EmaError}。
 *
 * @remarks
 * 跨包边界或异步链中捕获异常时，`instanceof` 可能因 prototype chain 断裂而失效。
 * 使用此守卫可安全收窄类型，确保访问 `code` 与 `retryable` 字段。
 *
 * @example
 * ```ts
 * try {
 *   await someRuntimeCall();
 * } catch (err) {
 *   if (isEmaError(err)) {
 *     if (err.retryable) await retry();
 *     else return { success: false, code: err.code };
 *   }
 *   throw err;
 * }
 * ```
 */
export function isEmaError(err: unknown): err is EmaError {
  return err instanceof EmaError;
}
