import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ModelDescriptor,
  ModelId,
  ProviderId,
  ToolSpec,
} from "@ema-agent/core-types"

import { ModelCatalog } from "./models/catalog.js"
import { fetchModels } from "./models/fetch.js"
import { ProviderCatalog } from "./providers/catalog.js"
import type { LlmConfig, LlmProviderSpec } from "./providers/spec.js"
import { streamChat } from "./stream/chat.js"

export interface LlmChatRequest {
  providerId: ProviderId
  /** 远端模型名（直接传给 API，如 "gpt-4o-mini"、"deepseek-chat"）。 */
  modelId: ModelId
  messages: ChatCompletionMessage[]
  tools?: ToolSpec[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * LLM 执行层唯一入口。
 *
 * 职责：
 * - 管理 provider 配置（CRUD）
 * - 缓存远端模型列表
 * - 执行流式聊天（委托给 @xsai/stream-text）
 *
 * 不感知业务角色（chat/agent/narrative）、不做 role → model 绑定。
 * 调用方直接指定 providerId + modelId。
 */
export class LlmClient {
  private readonly providers = new ProviderCatalog()
  private readonly models = new ModelCatalog()

  // ── 配置管理 ──────────────────────────────────────────────────

  /** 批量加载配置，通常在服务启动时由外部（env / DB）调用一次。 */
  applyConfig(config: LlmConfig): void {
    for (const spec of config.providers) {
      this.providers.upsert(spec)
    }
  }

  upsertProvider(spec: LlmProviderSpec): void {
    this.providers.upsert(spec)
  }

  removeProvider(id: ProviderId): void {
    this.providers.remove(id)
    this.models.removeByProvider(id)
  }

  // ── 发现 ──────────────────────────────────────────────────────

  listProviders(): LlmProviderSpec[] {
    return this.providers.list()
  }

  listModels(providerId?: ProviderId): ModelDescriptor[] {
    return this.models.list(providerId)
  }

  /** 从远端拉取模型列表并更新缓存。失败时抛错，调用方决定是否降级。 */
  async refreshModels(providerId: ProviderId, signal?: AbortSignal): Promise<void> {
    const spec = this.requireSpec(providerId)
    const fetched = await fetchModels(spec, signal)
    this.models.upsertMany(fetched)
  }

  // ── 执行 ──────────────────────────────────────────────────────

  async *streamChat(request: LlmChatRequest): AsyncIterable<ChatCompletionChunk> {
    const spec = this.requireSpec(request.providerId)
    if (!spec.enabled) {
      throw new Error(`Provider "${request.providerId}" is disabled.`)
    }
    yield* streamChat({
      spec,
      modelId: String(request.modelId),
      messages: request.messages,
      tools: request.tools,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      signal: request.signal,
    })
  }

  // ── 内部 ──────────────────────────────────────────────────────

  private requireSpec(providerId: ProviderId): LlmProviderSpec {
    const spec = this.providers.get(providerId)
    if (!spec) throw new Error(`Provider not found: "${providerId}"`)
    return spec
  }
}
