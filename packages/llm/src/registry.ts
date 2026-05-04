import { EmaError } from "@ema-agent/core-types"
import type {
  ChatCompletionChunk,
  ModelDescriptor,
  ModelRole,
  ModelId,
  ProviderDescriptor,
  ProviderHealthView,
  ProviderId,
  ProviderKind,
} from "@ema-agent/core-types"

import { createAnthropicAdapter } from "./adapters/anthropic.js"
import { createGeminiAdapter } from "./adapters/gemini.js"
import { createLocalDevAdapter } from "./adapters/local-dev.js"
import { createOpenAiCompatibleAdapter } from "./adapters/openai-compatible.js"
import { createOpenAiAdapter } from "./adapters/openai.js"
import { ModelCatalog } from "./catalog.js"
import type {
  FetchLike,
  LlmAdapter,
  LlmConfigSnapshot,
  LlmProviderConfig,
  LlmRegistryOptions,
  LlmStreamRequest,
  ModelBinding,
  ModelBindingConfig,
} from "./types.js"
import { normalizeProviderError } from "./usage.js"

/**
 * LLM 注册中心。
 *
 * 职责边界：
 * - 保存 provider 配置。
 * - 保存 adapter 实例。
 * - 维护模型目录和角色绑定。
 * - 按 providerId 找到正确 adapter 执行 listModels / health / streamChat。
 *
 * 不做的事：
 * - 不保存密钥到磁盘。
 * - 不拼 prompt。
 * - 不做 turn/session 生命周期。
 */
export class LlmRegistry {
  private readonly adapters = new Map<ProviderKind, LlmAdapter>()
  private readonly providers = new Map<string, LlmProviderConfig>()
  private readonly catalog = new ModelCatalog()
  private readonly fetchLike?: FetchLike

  constructor(options: LlmRegistryOptions = {}) {
    this.fetchLike = options.fetch

    for (const adapter of options.adapters ?? createDefaultAdapters()) {
      this.registerAdapter(adapter)
    }

    for (const provider of options.providers ?? []) {
      this.upsertProvider(provider)
    }
  }

  registerAdapter(adapter: LlmAdapter): void {
    this.adapters.set(adapter.kind, adapter)
  }

  upsertProvider(config: LlmProviderConfig): void {
    const provider = this.withInjectedFetch(config)
    this.providers.set(provider.id, provider)
    this.catalog.upsertMany(provider.staticModels ?? [])
  }

  updateProvider(providerId: ProviderId, patch: Partial<LlmProviderConfig>): LlmProviderConfig {
    const current = this.getProvider(providerId)
    const next = this.withInjectedFetch({
      ...current,
      ...patch,
      id: current.id,
      kind: patch.kind ?? current.kind,
    })

    this.providers.set(providerId, next)
    this.catalog.upsertMany(next.staticModels ?? [])
    return this.redactProviderSecret(next)
  }

  getProviderConfig(providerId: ProviderId): LlmProviderConfig {
    return this.redactProviderSecret(this.getProvider(providerId))
  }

  listProviderConfigs(): LlmProviderConfig[] {
    return [...this.providers.values()].map((provider) => this.redactProviderSecret(provider))
  }

  applyConfig(config: LlmConfigSnapshot): void {
    for (const provider of config.providers) {
      this.upsertProvider(provider)
    }

    for (const binding of Object.values(config.bindings)) {
      if (binding) {
        this.bindRole(binding)
      }
    }
  }

  listProviders(): ProviderDescriptor[] {
    return [...this.providers.values()].map((provider) => {
      return this.getAdapter(provider.kind).createDescriptor(provider)
    })
  }

  listKnownModels(providerId?: ProviderId): ModelDescriptor[] {
    return this.catalog.list(providerId)
  }

  async refreshModels(providerId: ProviderId): Promise<ModelDescriptor[]> {
    const provider = this.getProvider(providerId)
    const models = await this.getAdapter(provider.kind).listModels(provider)
    this.catalog.upsertMany(models)
    return models
  }

  async checkHealth(providerId: ProviderId): Promise<ProviderHealthView> {
    const provider = this.getProvider(providerId)
    return this.getAdapter(provider.kind).checkHealth(provider)
  }

  bindRole(binding: ModelBinding): void {
    this.catalog.bindRole(binding)
  }

  getBinding(role: ModelRole): ModelBinding | undefined {
    return this.catalog.getBinding(role)
  }

  getBindingsSnapshot(): ModelBindingConfig {
    return this.catalog.snapshotBindings()
  }

  getConfigSnapshot(): LlmConfigSnapshot {
    return {
      providers: this.listProviderConfigs(),
      bindings: this.getBindingsSnapshot(),
    }
  }

  streamChat(request: LlmStreamRequest): AsyncIterable<ChatCompletionChunk> {
    const provider = this.getProvider(request.providerId)

    if (!provider.enabled) {
      throw new EmaError("provider_unavailable", `Provider ${provider.displayName} is disabled.`, true)
    }

    return this.getAdapter(provider.kind).streamChat(provider, request)
  }

  async *streamChatWithFallback(request: LlmStreamRequest, fallbackModelIds: readonly ModelId[] = []): AsyncIterable<ChatCompletionChunk> {
    const candidates = [request.modelId, ...fallbackModelIds]
    let lastError: unknown

    for (const modelId of candidates) {
      try {
        yield* this.streamChat({
          ...request,
          modelId,
        })
        return
      } catch (error) {
        lastError = error
      }
    }

    throw normalizeProviderError(lastError)
  }

  private getProvider(providerId: ProviderId): LlmProviderConfig {
    const provider = this.providers.get(providerId)
    if (!provider) {
      throw new EmaError("provider_unavailable", `Provider ${providerId} is not registered.`, false)
    }
    return provider
  }

  private getAdapter(kind: ProviderKind): LlmAdapter {
    const adapter = this.adapters.get(kind)
    if (!adapter) {
      throw new EmaError("provider_unavailable", `Provider adapter ${kind} is not registered.`, false)
    }
    return adapter
  }

  private withInjectedFetch(config: LlmProviderConfig): LlmProviderConfig {
    return {
      ...config,
      fetch: config.fetch ?? this.fetchLike,
    }
  }

  private redactProviderSecret(config: LlmProviderConfig): LlmProviderConfig {
    return {
      ...config,
      apiKey: config.apiKey ? "********" : undefined,
      fetch: undefined,
    }
  }
}

export function createDefaultAdapters(): LlmAdapter[] {
  return [
    createLocalDevAdapter(),
    createOpenAiAdapter(),
    createAnthropicAdapter(),
    createGeminiAdapter(),
    createOpenAiCompatibleAdapter(),
  ]
}
