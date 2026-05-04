import { asId } from "@ema-agent/core-types"
import type {
  ModelDescriptor,
  ModelId,
  ProviderDescriptor,
  ProviderId,
  UserMessage,
} from "@ema-agent/core-types"

import type { LlmAdapter, LlmProviderConfig, LlmStreamRequest } from "../types.js"
import { TEXT_MODEL_CAPABILITIES } from "../types.js"

/**
 * 本地开发 Provider。
 *
 * 它不访问网络，也不假装是生产模型。作用是让新机器在没有 API Key 时
 * 仍然能跑通 turn -> SSE -> 消息落盘这条闭环，方便先开发产品主流程。
 */
export function createLocalDevAdapter(): LlmAdapter {
  return {
    kind: "local-dev",
    displayName: "Local Dev",

    createDescriptor(config) {
      return createLocalDevDescriptor(config)
    },

    async listModels(config) {
      return config.staticModels ?? [createLocalDevModel(config.id)]
    },

    async checkHealth() {
      const checkedAt = Date.now()
      return {
        status: "ok",
        checkedAt,
        latencyMs: 0,
        message: "本地开发 Provider 可用。",
      }
    },

    async *streamChat(_config, request) {
      const startedAt = Date.now()
      const reply = createLocalReply(request)
      let index = 0

      for (const chunk of chunkText(reply, 12)) {
        await sleep(12)
        yield {
          index: index++,
          delta: { content: chunk },
          finishReason: null,
        }
      }

      yield {
        index,
        delta: {},
        usage: {
          inputTokens: estimateTokens(getLastUserText(request)),
          outputTokens: estimateTokens(reply),
          totalTokens: estimateTokens(getLastUserText(request)) + estimateTokens(reply),
        },
        finishReason: "stop",
        raw: { provider: "local-dev", startedAt },
      }
    },
  }
}

export function createLocalDevDescriptor(config: LlmProviderConfig): ProviderDescriptor {
  return {
    id: config.id,
    displayName: config.displayName,
    category: "llm",
    kind: "local-dev",
    enabled: config.enabled,
    configured: true,
    supportsRemoteModels: false,
    health: {
      status: config.enabled ? "ok" : "disabled",
    },
  }
}

export function createLocalDevModel(providerId: ProviderId): ModelDescriptor {
  return {
    id: asId<ModelId>(`${providerId}/ema-local-chat`),
    displayName: "Ema Local Chat",
    providerId,
    roles: ["chat", "agent", "narrative", "title"],
    capabilities: {
      ...TEXT_MODEL_CAPABILITIES,
      listModels: false,
    },
    contextWindow: 16_000,
    maxOutputTokens: 2_048,
    source: "static",
  }
}

function createLocalReply(request: LlmStreamRequest): string {
  const lastUserText = getLastUserText(request)
  if (request.modelId.includes("title")) {
    return createTitle(lastUserText)
  }

  return [
    "我在，这轮先用本地开发 Provider 跑通闭环。",
    `你刚才说：${lastUserText || "空输入"}`,
    "等你在 Provider 设置里填好真实模型后，这里会走对应厂商的流式接口。",
  ].join("\n")
}

function getLastUserText(request: LlmStreamRequest): string {
  const message = [...request.messages].reverse().find((item): item is UserMessage => item.role === "user")
  if (!message) {
    return ""
  }

  if (typeof message.content === "string") {
    return message.content
  }

  return message.content
    .map((part) => part.type === "text" ? part.text : `[image:${part.imageUrl.url}]`)
    .join("\n")
    .trim()
}

function createTitle(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ")
  if (!cleaned) {
    return "新对话"
  }
  return cleaned.length <= 18 ? cleaned : `${cleaned.slice(0, 18)}...`
}

function* chunkText(text: string, chunkSize: number): Iterable<string> {
  for (let index = 0; index < text.length; index += chunkSize) {
    yield text.slice(index, index + chunkSize)
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
