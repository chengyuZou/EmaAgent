/**
 * 工具调用不支持的错误模式——来自各厂商的实际错误消息，补全自 AIRI。
 * isToolUnsupportedError() 返回 true 时，上层应缓存该模型为不支持工具。
 */
export const TOOL_UNSUPPORTED_PATTERNS: RegExp[] = [
  /does not support tools/i,
  /no endpoints found that support tool use/i,
  /invalid schema for function/i,
  /invalid.?function.?parameters/i,
  /functions are not supported/i,
  /unrecognized request argument.+tools/i,
  /tool use with function calling is unsupported/i,
  /tool_use_failed/i,
  /does not support function.?calling/i,
  /tools?\s+(is|are)\s+not\s+supported/i,
]

export function isToolUnsupportedError(error: unknown): boolean {
  const msg = errorMessage(error)
  return TOOL_UNSUPPORTED_PATTERNS.some(p => p.test(msg))
}

/** 将 provider 原始错误归一化为 Error，保留原始消息。 */
export function normalizeProviderError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
