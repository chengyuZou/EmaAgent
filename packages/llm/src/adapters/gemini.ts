import { asId } from "@ema-agent/core-types"
import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ModelDescriptor,
  ModelId,
} from "@ema-agent/core-types"

import { joinUrl, requestJson, resolveFetch, streamSseJson } from "../transport.js"
import type { LlmAdapter, LlmStreamRequest } from "../types.js"
import { TOOL_MODEL_CAPABILITIES } from "../types.js"
import { createDescriptor, getSystemPrompt, resolveRemoteModel } from "./common.js"

interface GeminiModelListResponse {
  models?: Array<{
    name: string
    displayName?: string
    inputTokenLimit?: number
    outputTokenLimit?: number
  }>
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

interface GeminiContent {
  role: "user" | "model"
  parts: Array<{ text: string }>
}

/**
 * Gemini GenerateContent API 适配器。
 *
 * Gemini 的消息结构是 contents/parts，不是 OpenAI messages。
 * 这里先把所有非文本内容降级成可读文本占位，保证 V1 文本链路稳定。
 */
export function createGeminiAdapter(): LlmAdapter {
  return {
    kind: "gemini",
    displayName: "Gemini",

    createDescriptor(config) {
      return createDescriptor(config, "gemini")
    },

    async listModels(config) {
      if (!config.enabled || !config.baseUrl || !config.apiKey) {
        return config.staticModels ?? []
      }

      const response = await requestJson<GeminiModelListResponse>(
        resolveFetch(config.fetch),
        `${joinUrl(config.baseUrl, "/models")}?key=${encodeURIComponent(config.apiKey)}`,
        {
          method: "GET",
          headers: {
            ...config.headers,
          },
        },
      )

      return (response.data.models ?? []).map((model): ModelDescriptor => {
        const remoteModelId = model.name.replace(/^models\//, "")

        return {
          id: asId<ModelId>(`${config.id}/${remoteModelId}`),
          displayName: model.displayName ?? remoteModelId,
          providerId: config.id,
          roles: ["chat", "agent", "narrative", "title"],
          capabilities: TOOL_MODEL_CAPABILITIES,
          contextWindow: model.inputTokenLimit ?? 128_000,
          maxOutputTokens: model.outputTokenLimit ?? 8_192,
          source: "remote",
          updatedAt: Date.now(),
        }
      })
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
      const remoteModel = resolveRemoteModel(config, request.modelId)
      const response = await resolveFetch(config.fetch)(
        `${joinUrl(config.baseUrl, `/models/${remoteModel}:streamGenerateContent`)}?alt=sse&key=${encodeURIComponent(config.apiKey ?? "")}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...config.headers,
          },
          body: JSON.stringify(buildGeminiRequestBody(request)),
        },
      )

      let index = 0
      for await (const raw of streamSseJson<GeminiStreamChunk>(response)) {
        const chunk = mapGeminiChunk(raw, index++)
        if (chunk.delta.content || chunk.usage || chunk.finishReason) {
          yield chunk
        }
      }
    },
  }
}

function buildGeminiRequestBody(request: LlmStreamRequest): Record<string, unknown> {
  return removeUndefined({
    systemInstruction: getSystemPrompt(request)
      ? { parts: [{ text: getSystemPrompt(request) }] }
      : undefined,
    contents: request.messages
      .filter((message) => message.role !== "system")
      .map(toGeminiContent),
    tools: request.tools?.length
      ? [
          {
            functionDeclarations: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          },
        ]
      : undefined,
    generationConfig: removeUndefined({
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
      topP: request.topP,
    }),
    ...request.providerOptions,
  })
}

function toGeminiContent(message: Exclude<ChatCompletionMessage, { role: "system" }>): GeminiContent {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        parts: [{ text: contentToText(message.content) }],
      }
    case "assistant":
      return {
        role: "model",
        parts: [{ text: message.content ?? "" }],
      }
    case "tool":
      return {
        role: "user",
        parts: [{ text: message.content }],
      }
  }
}

function mapGeminiChunk(raw: GeminiStreamChunk, index: number): ChatCompletionChunk {
  const candidate = raw.candidates?.[0]
  const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("")
  const usage = raw.usageMetadata

  return {
    index,
    delta: { content: text || undefined },
    usage: usage
      ? {
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
          totalTokens: usage.totalTokenCount ?? 0,
        }
      : undefined,
    finishReason: normalizeGeminiFinishReason(candidate?.finishReason),
    raw,
  }
}

function contentToText(content: ChatCompletionMessage extends infer Message
  ? Message extends { content: infer Content } ? Content : never
  : never): string {
  if (typeof content === "string") {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => part.type === "text" ? part.text : `[image:${part.imageUrl.url}]`)
      .join("\n")
  }

  return ""
}

function normalizeGeminiFinishReason(reason: string | undefined): ChatCompletionChunk["finishReason"] {
  switch (reason) {
    case undefined:
      return null
    case "STOP":
      return "stop"
    case "MAX_TOKENS":
      return "length"
    case "SAFETY":
    case "RECITATION":
      return "content_filter"
    default:
      return null
  }
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}
