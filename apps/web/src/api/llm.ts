import type {
  ModelDescriptor,
  ModelRole,
  ProviderDescriptor,
  ProviderHealthView,
} from "@ema-agent/core-types"
import type { LlmConfigSnapshot, LlmProviderConfig, ModelBinding, ModelBindingConfig } from "@ema-agent/llm"

export interface LlmApiClientOptions {
  apiBaseUrl?: string
  fetch?: typeof fetch
}

/**
 * 前端 LLM API client。
 *
 * 这里保持框架无关：React、Vue、Tauri WebView 都可以复用。
 * 具体 UI 只需要调用这些方法，不直接散落 fetch 细节。
 */
export function createLlmApiClient(options: LlmApiClientOptions = {}) {
  const apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl)
  const fetchLike = options.fetch ?? globalThis.fetch?.bind(globalThis)

  if (!fetchLike) {
    throw new Error("当前环境没有可用 fetch。")
  }

  return {
    async listProviders(): Promise<ProviderDescriptor[]> {
      const response = await requestJson<{ items: ProviderDescriptor[] }>(fetchLike, `${apiBaseUrl}/api/providers`)
      return response.items
    },

    async getConfig(): Promise<LlmConfigSnapshot> {
      return requestJson<LlmConfigSnapshot>(fetchLike, `${apiBaseUrl}/api/llm/config`)
    },

    async updateProvider(providerId: string, patch: Partial<LlmProviderConfig>): Promise<LlmProviderConfig> {
      const response = await requestJson<{ config: LlmProviderConfig }>(
        fetchLike,
        `${apiBaseUrl}/api/providers/${encodeURIComponent(providerId)}`,
        {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify(patch),
        },
      )
      return response.config
    },

    async listModels(providerId?: string): Promise<ModelDescriptor[]> {
      const url = providerId
        ? `${apiBaseUrl}/api/providers/${encodeURIComponent(providerId)}/models`
        : `${apiBaseUrl}/api/models`
      const response = await requestJson<{ items: ModelDescriptor[] }>(fetchLike, url)
      return response.items
    },

    async refreshModels(providerId: string): Promise<ModelDescriptor[]> {
      const response = await requestJson<{ items: ModelDescriptor[] }>(
        fetchLike,
        `${apiBaseUrl}/api/providers/${encodeURIComponent(providerId)}/refresh-models`,
        { method: "POST" },
      )
      return response.items
    },

    async checkHealth(providerId: string): Promise<ProviderHealthView> {
      return requestJson<ProviderHealthView>(
        fetchLike,
        `${apiBaseUrl}/api/providers/${encodeURIComponent(providerId)}/health`,
        { method: "POST" },
      )
    },

    async getBindings(): Promise<ModelBindingConfig> {
      const response = await requestJson<{ bindings: ModelBindingConfig }>(fetchLike, `${apiBaseUrl}/api/models/bindings`)
      return response.bindings
    },

    async bindModel(input: { role: ModelRole; providerId: string; modelId: string }): Promise<ModelBinding> {
      const response = await requestJson<{ binding: ModelBinding }>(
        fetchLike,
        `${apiBaseUrl}/api/models/bindings`,
        {
          method: "PUT",
          headers: jsonHeaders(),
          body: JSON.stringify(input),
        },
      )
      return response.binding
    },
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  if (!value) {
    return ""
  }
  return value.replace(/\/+$/, "")
}

function jsonHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
  }
}

async function requestJson<T>(fetchLike: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchLike(url, {
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
    ...init,
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) as T : {} as T

  if (!response.ok) {
    const message = typeof data === "object" && data && "message" in data
      ? String((data as { message: unknown }).message)
      : `HTTP ${response.status}`
    throw new Error(message)
  }

  return data
}
