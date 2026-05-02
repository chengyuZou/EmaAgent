import type {
  ModelDescriptor,
  ModelRole,
  ProviderDescriptor,
  ProviderHealthView,
} from "@ema-agent/core-types"
import type { ModelBinding, ModelBindingConfig } from "@ema-agent/llm"

export interface LlmApiClientOptions {
  apiBaseUrl?: string
  fetch?: typeof fetch
}

/**
 * 前端 LLM API client 骨架。
 *
 * 后续这里再补 fetch、错误归一化、缓存失效和设置页状态同步。
 */
export function createLlmApiClient(options: LlmApiClientOptions = {}) {
  void options

  return {
    async listProviders(): Promise<ProviderDescriptor[]> {
      return []
    },

    async listModels(providerId?: string): Promise<ModelDescriptor[]> {
      void providerId
      return []
    },

    async refreshModels(providerId: string): Promise<ModelDescriptor[]> {
      void providerId
      return []
    },

    async checkHealth(providerId: string): Promise<ProviderHealthView> {
      void providerId
      return {
        status: "unknown",
      }
    },

    async getBindings(): Promise<ModelBindingConfig> {
      return {}
    },

    async bindModel(input: { role: ModelRole; providerId: string; modelId: string }): Promise<ModelBinding> {
      return input as ModelBinding
    },
  }
}
