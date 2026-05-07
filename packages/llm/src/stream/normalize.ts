import { asId } from "@ema-agent/core-types"
import type { ChatCompletionChunk, ToolCallChunk, ToolCallId } from "@ema-agent/core-types"

/**
 * xsai StreamTextEvent 的最小结构——只取我们关心的字段。
 * 使用 unknown 交叉类型兼容 xsai 的 WithUnknown 模式。
 */
export type XsaiStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-streaming-start"; toolCallId: string; toolName: string }
  | { type: "tool-call-delta"; toolCallId: string; toolName: string; argsTextDelta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; result?: unknown }
  | { type: "finish"; finishReason: string; usage?: XsaiUsage }
  | { type: "error"; error: unknown }

export interface XsaiUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

/**
 * 将单个 xsai 事件归一化为零个或一个 ChatCompletionChunk。
 * 调用方维护 index 计数器，每次 yield 后自增。
 */
export function normalizeEvent(
  event: XsaiStreamEvent,
  index: number,
): ChatCompletionChunk | null {
  switch (event.type) {
    case "text-delta":
      return { index, delta: { content: event.text }, finishReason: null }

    case "tool-call-streaming-start":
      return {
        index,
        delta: {},
        toolCalls: [
          {
            id: asId<ToolCallId>(event.toolCallId),
            toolName: event.toolName,
            argumentsDelta: "",
          } satisfies ToolCallChunk,
        ],
        finishReason: null,
      }

    case "tool-call-delta":
      return {
        index,
        delta: {},
        toolCalls: [
          {
            id: asId<ToolCallId>(event.toolCallId),
            toolName: event.toolName,
            argumentsDelta: event.argsTextDelta,
          } satisfies ToolCallChunk,
        ],
        finishReason: null,
      }

    case "finish":
      return {
        index,
        delta: {},
        finishReason: mapFinishReason(event.finishReason),
        usage: event.usage ? mapUsage(event.usage) : undefined,
      }

    case "error":
      throw event.error instanceof Error
        ? event.error
        : new Error(String(event.error))

    // tool-call（完整）、tool-result、reasoning-delta 暂不向上层暴露
    default:
      return null
  }
}

function mapFinishReason(
  reason: string,
): ChatCompletionChunk["finishReason"] {
  switch (reason) {
    case "stop":           return "stop"
    case "length":         return "length"
    case "tool-calls":     return "tool_calls"
    case "content_filter": return "content_filter"
    case "error":          return "error"
    default:               return null
  }
}

function mapUsage(usage: XsaiUsage): NonNullable<ChatCompletionChunk["usage"]> {
  return {
    inputTokens:  usage.promptTokens     ?? 0,
    outputTokens: usage.completionTokens ?? 0,
    totalTokens:  usage.totalTokens      ?? 0,
  }
}
