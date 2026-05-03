import { EmaError, asId } from "@ema-agent/core-types"
import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionRequest,
  MessageContentPart,
  ModelDescriptor,
  ModelId,
  ProviderDescriptor,
  ProviderHealthView,
  ProviderId,
  ProviderKind,
  ToolCallChunk,
  ToolCallId,
  ToolSpec,
} from "@ema-agent/core-types"

import { bearerHeaders, joinUrl, requestJson, resolveFetch, streamSseJson } from "../transport.js"
import type { LlmAdapter, LlmProviderConfig, LlmStreamRequest } from "../types.js"
import { TEXT_MODEL_CAPABILITIES, TOOL_MODEL_CAPABILITIES } from "../types.js"

export interface OpenAiLikeAdapterOptions {
  kind: Extract<ProviderKind, "openai" | "openai-compatible">
  displayName: string
}

interface OpenAiModelListResponse {
  data?: Array<{
    id: string
    created?: number
    owned_by?: string
  }>
}

interface OpenAiChatCompletionChunk {
  id?: string
  choices?: Array<{
    index?: number
    delta?: {
      content?: string | null
      tool_calls?: OpenAiToolCallDelta[]
    }
    finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

type OpenAiFinishReason = NonNullable<NonNullable<OpenAiChatCompletionChunk["choices"]>[number]["finish_reason"]>

interface OpenAiToolCallDelta {
  index?: number
  id?: string
  type?: "function"
  function?: {
    name?: string
    arguments?: string
  }
}

interface OpenAiToolSpec {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool"
  content?: string | OpenAiContentPart[] | null
  tool_call_id?: string
  name?: string
  tool_calls?: OpenAiAssistantToolCall[]
}

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }

interface OpenAiAssistantToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export function createOpenAiLikeAdapter(options: OpenAiLikeAdapterOptions): LlmAdapter {
  return {
    kind: options.kind,
    displayName: options.displayName,

    createDescriptor(config) {
      return createDescriptor(config, options.kind)
    },

    async listModels(config) {
      if (!config.enabled || !config.baseUrl) {
        return config.staticModels ?? []
      }

      const response = await requestJson<OpenAiModelListResponse>(
        resolveFetch(config.fetch),
        joinUrl(config.baseUrl, "/models"),
        {
          method: "GET",
          headers: bearerHeaders(config.apiKey, config.headers),
        },
      )

      return (response.data.data ?? []).map((model) => createRemoteModel(config.id, model.id))
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
        return toProviderHealthError(error, startedAt)
      }
    },

    async *streamChat(config, request) {
      if (!config.enabled) {
        throw new EmaError("provider_unavailable", `Provider ${config.displayName} is disabled.`, true)
      }

      if (!config.baseUrl) {
        throw new EmaError("provider_unavailable", `Provider ${config.displayName} has no baseUrl.`, false)
      }

      const response = await resolveFetch(config.fetch)(joinUrl(config.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: bearerHeaders(config.apiKey, config.headers),
        body: JSON.stringify(buildOpenAiChatRequestBody(config, request)),
      })

      let index = 0
      for await (const raw of streamSseJson<OpenAiChatCompletionChunk>(response)) {
        const chunk = mapOpenAiChunk(raw, index++)
        if (shouldYieldChunk(chunk)) {
          yield chunk
        }
      }
    },
  }
}

export function resolveRemoteModel(config: LlmProviderConfig, modelId: ModelId): string {
  const alias = config.modelAliases?.[modelId]
  if (alias) {
    return alias
  }

  const rawModelId = String(modelId)
  const providerPrefix = `${config.id}/`
  return rawModelId.startsWith(providerPrefix) ? rawModelId.slice(providerPrefix.length) : rawModelId
}

export function createDescriptor(config: LlmProviderConfig, kind: ProviderKind): ProviderDescriptor {
  return {
    id: config.id,
    displayName: config.displayName,
    category: "llm",
    kind,
    enabled: config.enabled,
    configured: Boolean(config.baseUrl) && (Boolean(config.apiKey) || String(config.id) === "ollama"),
    supportsRemoteModels: true,
    health: {
      status: "unknown",
    },
  }
}

export function createRemoteModel(providerId: ProviderId, modelId: string): ModelDescriptor {
  return {
    id: asId<ModelId>(`${providerId}/${modelId}`),
    displayName: modelId,
    providerId,
    roles: ["chat", "agent", "narrative", "title"],
    capabilities: TOOL_MODEL_CAPABILITIES,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    source: "remote",
    updatedAt: Date.now(),
  }
}

export function getSystemPrompt(request: ChatCompletionRequest): string | undefined {
  return request.messages.find((message) => message.role === "system")?.content
}

export function mapOpenAiChunk(raw: OpenAiChatCompletionChunk, index: number): ChatCompletionChunk {
  const choice = raw.choices?.[0]

  return {
    id: raw.id,
    index,
    delta: {
      content: choice?.delta?.content ?? undefined,
    },
    toolCalls: mapOpenAiToolCalls(choice?.delta?.tool_calls),
    usage: raw.usage
      ? {
          inputTokens: raw.usage.prompt_tokens ?? 0,
          outputTokens: raw.usage.completion_tokens ?? 0,
          totalTokens: raw.usage.total_tokens ?? 0,
        }
      : undefined,
    finishReason: normalizeFinishReason(choice?.finish_reason),
    raw,
  }
}

export function buildOpenAiChatRequestBody(config: LlmProviderConfig, request: LlmStreamRequest): Record<string, unknown> {
  return removeUndefined({
    model: resolveRemoteModel(config, request.modelId),
    messages: request.messages.map(toOpenAiMessage),
    stream: true,
    tools: request.tools?.map(toOpenAiToolSpec),
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    top_p: request.topP,
    ...request.providerOptions,
  })
}

export function toOpenAiToolSpec(tool: ToolSpec): OpenAiToolSpec {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function toOpenAiMessage(message: ChatCompletionMessage): OpenAiMessage {
  switch (message.role) {
    case "system":
      return {
        role: "system",
        content: message.content,
      }

    case "user":
      return {
        role: "user",
        content: typeof message.content === "string"
          ? message.content
          : message.content.map(toOpenAiContentPart),
      }

    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls?.map(toOpenAiAssistantToolCall),
      }

    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: message.content,
      }
  }
}

function toOpenAiContentPart(part: MessageContentPart): OpenAiContentPart {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        text: part.text,
      }

    case "image_url":
      return {
        type: "image_url",
        image_url: part.imageUrl,
      }
  }
}

function toOpenAiAssistantToolCall(toolCall: ToolCallChunk): OpenAiAssistantToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.toolName,
      arguments: toolCall.argumentsDelta,
    },
  }
}

function mapOpenAiToolCalls(toolCalls: OpenAiToolCallDelta[] | undefined): ToolCallChunk[] | undefined {
  if (!toolCalls || toolCalls.length === 0) {
    return undefined
  }

  return toolCalls.map((toolCall, index) => ({
    id: asId<ToolCallId>(toolCall.id ?? `tool_${toolCall.index ?? index}`),
    toolName: toolCall.function?.name ?? "",
    argumentsDelta: toolCall.function?.arguments ?? "",
    index: toolCall.index ?? index,
  }))
}

function normalizeFinishReason(finishReason: OpenAiFinishReason | null | undefined): ChatCompletionChunk["finishReason"] {
  switch (finishReason) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
      return finishReason

    case "function_call":
      return "tool_calls"

    default:
      return null
  }
}

function shouldYieldChunk(chunk: ChatCompletionChunk): boolean {
  return Boolean(
    chunk.delta.content !== undefined ||
      chunk.toolCalls?.length ||
      chunk.usage ||
      chunk.finishReason,
  )
}

function toProviderHealthError(error: unknown, startedAt: number): ProviderHealthView {
  return {
    status: "down",
    checkedAt: Date.now(),
    latencyMs: Date.now() - startedAt,
    message: error instanceof Error ? error.message : String(error),
  }
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

export const DEFAULT_OPENAI_COMPATIBLE_CAPABILITIES = TEXT_MODEL_CAPABILITIES
