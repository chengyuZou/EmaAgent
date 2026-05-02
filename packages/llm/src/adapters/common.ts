import { asId } from "@ema-agent/core-types"
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ModelDescriptor,
  ModelId,
  ProviderDescriptor,
  ProviderId,
  ProviderKind,
} from "@ema-agent/core-types"

import type { LlmAdapter, LlmProviderConfig, LlmStreamRequest } from "../types.js"
import { TEXT_MODEL_CAPABILITIES } from "../types.js"

export interface LlmAdapterSkeletonOptions {
  kind: ProviderKind
  displayName: string
}

/**
 * 通用 adapter 骨架。
 *
 * 各 provider 先共享同一套空实现，后面你可以把 OpenAI / Anthropic /
 * Gemini 的真实协议解析分别拆回各自文件里。
 */
export function createLlmAdapterSkeleton(options: LlmAdapterSkeletonOptions): LlmAdapter {
  return {
    kind: options.kind,
    displayName: options.displayName,

    createDescriptor(config) {
      return createDescriptor(config, options.kind)
    },

    async listModels(config) {
      void config
      return []
    },

    async checkHealth(config) {
      void config
      return {
        status: "unknown",
      }
    },

    async *streamChat(config: LlmProviderConfig, request: LlmStreamRequest): AsyncIterable<ChatCompletionChunk> {
      void config
      void request
    },
  }
}

export function resolveRemoteModel(config: LlmProviderConfig, modelId: ModelId): string {
  void config
  return modelId
}

export function createDescriptor(config: LlmProviderConfig, kind: ProviderKind): ProviderDescriptor {
  return {
    id: config.id,
    displayName: config.displayName,
    category: "llm",
    kind,
    enabled: config.enabled,
    configured: false,
    supportsRemoteModels: false,
  }
}

export function createRemoteModel(providerId: ProviderId, modelId: string): ModelDescriptor {
  return {
    id: asId<ModelId>(modelId),
    displayName: modelId,
    providerId,
    roles: [],
    capabilities: TEXT_MODEL_CAPABILITIES,
    contextWindow: 0,
    maxOutputTokens: 0,
    source: "remote",
  }
}

export function getSystemPrompt(request: ChatCompletionRequest): string | undefined {
  void request
  return undefined
}
