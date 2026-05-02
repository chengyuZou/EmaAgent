import type {
  ChatCompletionChunk,
  ModelDescriptor,
  ModelRole,
  ProviderDescriptor,
  ProviderHealthView,
  ProviderId,
} from "@ema-agent/core-types"

import { createAnthropicAdapter } from "./adapters/anthropic.js"
import { createGeminiAdapter } from "./adapters/gemini.js"
import { createOpenAiCompatibleAdapter } from "./adapters/openai-compatible.js"
import { createOpenAiAdapter } from "./adapters/openai.js"
import type {
  LlmAdapter,
  LlmConfigSnapshot,
  LlmRegistryOptions,
  LlmStreamRequest,
  ModelBinding,
  ModelBindingConfig,
} from "./types.js"

/**
 * LLM 注册中心骨架。
 *
 * V1 这里会负责 provider 注册、模型目录、健康检查和角色绑定。
 * 当前先不写实际状态管理逻辑，只固定对外方法和返回类型。
 */
export class LlmRegistry {
  constructor(options: LlmRegistryOptions = {}) {
    void options
  }

  registerAdapter(adapter: LlmAdapter): void {
    void adapter
  }

  upsertProvider(config: LlmConfigSnapshot["providers"][number]): void {
    void config
  }

  applyConfig(config: LlmConfigSnapshot): void {
    void config
  }

  listProviders(): ProviderDescriptor[] {
    return []
  }

  listKnownModels(providerId?: ProviderId): ModelDescriptor[] {
    void providerId
    return []
  }

  async refreshModels(providerId: ProviderId): Promise<ModelDescriptor[]> {
    void providerId
    return []
  }

  async checkHealth(providerId: ProviderId): Promise<ProviderHealthView> {
    void providerId
    return {
      status: "unknown",
    }
  }

  bindRole(binding: ModelBinding): void {
    void binding
  }

  getBinding(role: ModelRole): ModelBinding | undefined {
    void role
    return undefined
  }

  getBindingsSnapshot(): ModelBindingConfig {
    return {}
  }

  async *streamChat(request: LlmStreamRequest): AsyncIterable<ChatCompletionChunk> {
    void request
  }
}

export function createDefaultAdapters(): LlmAdapter[] {
  return [
    createOpenAiAdapter(),
    createAnthropicAdapter(),
    createGeminiAdapter(),
    createOpenAiCompatibleAdapter(),
  ]
}
