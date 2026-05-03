import { asId } from "@ema-agent/core-types"
import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ModelDescriptor,
  ModelId,
  ToolCallId,
} from "@ema-agent/core-types"

import { joinUrl, requestJson, resolveFetch, streamSseJson } from "../transport.js"
import type { LlmAdapter, LlmProviderConfig, LlmStreamRequest } from "../types.js"
import { TOOL_MODEL_CAPABILITIES } from "../types.js"
import { createDescriptor, getSystemPrompt, resolveRemoteModel } from "./common.js"

interface AnthropicModelListResponse {
  data?: Array<{
    id: string
    display_name?: string
  }>
}

interface AnthropicStreamEvent {
  type: string
  index?: number
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    stop_reason?: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | string | null
  }
  content_block?: {
    id?: string
    type?: string
    name?: string
  }
  message?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
    }
  }
}

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result"
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
}

interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

/**
 * Anthropic Messages API 适配器。
 *
 * Anthropic 的流不是 OpenAI choices/delta，而是带 type 的语义事件：
 * - content_block_delta + text_delta：文本增量。
 * - content_block_delta + input_json_delta：工具参数 JSON 增量。
 * - message_delta：通常携带 usage 和 stop_reason。
 */
export function createAnthropicAdapter(): LlmAdapter {
  return {
    kind: "anthropic",
    displayName: "Anthropic",

    createDescriptor(config) {
      return createDescriptor(config, "anthropic")
    },

    async listModels(config) {
      if (!config.enabled || !config.baseUrl || !config.apiKey) {
        return config.staticModels ?? []
      }

      const response = await requestJson<AnthropicModelListResponse>(
        resolveFetch(config.fetch),
        joinUrl(config.baseUrl, "/v1/models"),
        {
          method: "GET",
          headers: anthropicHeaders(config),
        },
      )

      return (response.data.data ?? []).map((model): ModelDescriptor => ({
        id: asId<ModelId>(`${config.id}/${model.id}`),
        displayName: model.display_name ?? model.id,
        providerId: config.id,
        roles: ["chat", "agent", "narrative", "title"],
        capabilities: TOOL_MODEL_CAPABILITIES,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        source: "remote",
        updatedAt: Date.now(),
      }))
    },

    async checkHealth(config) {
      const startedAt = Date.now()

      if (!config.enabled) {
        return {
          status: "disabled",
          checkedAt: startedAt,
          message: "Provider is disabled.",
        }
      }

      try {
        await this.listModels(config)
        return {
          status: "ok",
          checkedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
        }
      } catch (error) {
        return {
          status: "down",
          checkedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },

    async *streamChat(config, request) {
      const response = await resolveFetch(config.fetch)(joinUrl(config.baseUrl, "/v1/messages"), {
        method: "POST",
        headers: anthropicHeaders(config),
        body: JSON.stringify(buildAnthropicRequestBody(config, request)),
      })

      let index = 0
      for await (const event of streamSseJson<AnthropicStreamEvent>(response)) {
        const chunk = mapAnthropicEvent(event, index++)
        if (chunk) {
          yield chunk
        }
      }
    },
  }
}

function buildAnthropicRequestBody(config: LlmProviderConfig, request: LlmStreamRequest): Record<string, unknown> {
  return removeUndefined({
    model: resolveRemoteModel(config, request.modelId),
    system: getSystemPrompt(request),
    messages: request.messages
      .filter((message) => message.role !== "system")
      .map(toAnthropicMessage),
    tools: request.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    max_tokens: request.maxTokens ?? 2_048,
    temperature: request.temperature,
    top_p: request.topP,
    stream: true,
    ...request.providerOptions,
  })
}

function toAnthropicMessage(message: Exclude<ChatCompletionMessage, { role: "system" }>): AnthropicMessage {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: typeof message.content === "string"
          ? message.content
          : message.content.map((part): AnthropicContentBlock => ({
              type: "text",
              text: part.type === "text" ? part.text : `[image:${part.imageUrl.url}]`,
            })),
      }

    case "assistant":
      return {
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...(message.toolCalls?.map((toolCall): AnthropicContentBlock => ({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.toolName,
            input: parseToolArguments(toolCall.argumentsDelta),
          })) ?? []),
        ],
      }

    case "tool":
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
          },
        ],
      }
  }
}

function mapAnthropicEvent(event: AnthropicStreamEvent, index: number): ChatCompletionChunk | undefined {
  if (event.type === "content_block_delta" && event.delta?.text) {
    return {
      index,
      delta: { content: event.delta.text },
      finishReason: null,
      raw: event,
    }
  }

  if (event.type === "content_block_delta" && event.delta?.partial_json) {
    return {
      index,
      delta: {},
      toolCalls: [
        {
          id: asId<ToolCallId>(event.content_block?.id ?? `tool_${event.index ?? index}`),
          index: event.index ?? 0,
          toolName: event.content_block?.name ?? "",
          argumentsDelta: event.delta.partial_json,
        },
      ],
      finishReason: null,
      raw: event,
    }
  }

  if (event.type === "message_delta") {
    const usage = event.message?.usage
    return {
      index,
      delta: {},
      usage: usage
        ? {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          }
        : undefined,
      finishReason: normalizeAnthropicStopReason(event.delta?.stop_reason),
      raw: event,
    }
  }

  return undefined
}

function normalizeAnthropicStopReason(reason: string | null | undefined): ChatCompletionChunk["finishReason"] {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop"
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool_calls"
    default:
      return null
  }
}

function anthropicHeaders(config: LlmProviderConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(config.apiKey ? { "x-api-key": config.apiKey } : {}),
    ...config.headers,
  }
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}
