import { streamText } from "@xsai/stream-text"
import type {
  AssistantMessage,
  ChatCompletionChunk,
  ChatCompletionMessage,
  SystemMessage,
  ToolCallChunk,
  ToolMessage,
  ToolSpec,
  UserMessage,
} from "@ema-agent/core-types"

import type { LlmProviderSpec } from "../providers/spec.js"
import { normalizeEvent, type XsaiStreamEvent } from "./normalize.js"

export interface ChatStreamInput {
  spec: LlmProviderSpec
  modelId: string
  messages: ChatCompletionMessage[]
  tools?: ToolSpec[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * 调用 @xsai/stream-text，将 xsai 事件流归一化为 AsyncIterable<ChatCompletionChunk>。
 * 所有 promise 都被消费以防止 unhandled rejection。
 */
export async function* streamChat(input: ChatStreamInput): AsyncIterable<ChatCompletionChunk> {
  const xsaiMessages = input.messages.map(toXsaiMessage)
  const xsaiTools = input.tools?.length ? input.tools.map(toXsaiTool) : undefined

  // xsai 的 Message 是严格判别联合，我们的转换函数保证了 role 字段存在，
  // 但 TypeScript 无法从 Record<string, unknown> 推断出来，用 unknown 过渡。
  const result = streamText({
    apiKey: input.spec.apiKey,
    baseURL: input.spec.baseUrl,
    model: input.modelId,
    messages: xsaiMessages,
    tools: xsaiTools,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    abortSignal: input.signal,
    headers: input.spec.headers,
  } as unknown as Parameters<typeof streamText>[0])

  // 消费 hanging promise，防止 unhandled rejection
  void result.messages.catch(() => {})
  void result.usage.catch(() => {})
  void result.steps.catch(() => {})
  void result.totalUsage.catch(() => {})

  const reader = result.fullStream.getReader()
  let index = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = normalizeEvent(value as XsaiStreamEvent, index)
      if (chunk) {
        index++
        yield chunk
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ── 消息格式转换：EmaAgent → xsai（OpenAI 标准）──

function toXsaiMessage(msg: ChatCompletionMessage): Record<string, unknown> {
  switch (msg.role) {
    case "system":
      return { role: "system", content: (msg as SystemMessage).content }

    case "user":
      return { role: "user", content: (msg as UserMessage).content }

    case "assistant": {
      const a = msg as AssistantMessage
      const out: Record<string, unknown> = { role: "assistant", content: a.content ?? null }
      if (a.toolCalls?.length) {
        out.tool_calls = a.toolCalls.map(tc => toXsaiToolCall(tc))
      }
      return out
    }

    case "tool": {
      const t = msg as ToolMessage
      return {
        role: "tool",
        tool_call_id: t.toolCallId,
        content: t.content,
      }
    }
  }
}

function toXsaiToolCall(tc: ToolCallChunk): Record<string, unknown> {
  return {
    id: tc.id,
    type: "function",
    function: {
      name: tc.toolName,
      arguments: tc.argumentsDelta,
    },
  }
}

function toXsaiTool(spec: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
    // 给 `@xsai` 提供一个空的 execute，防止其在内部处理步骤链时报错
    // EmaAgent 会自己将 toolCalls 扔给外部引擎，并不在流处理阶段执行 tool
    execute: () => {},
  }
}
