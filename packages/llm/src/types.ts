import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ModelCapabilities,
  ModelDescriptor,
  ModelId,
  ModelRole,
  ProviderDescriptor,
  ProviderHealthView,
  ProviderId,
  ProviderKind,
  UiErrorCode,
} from "@ema-agent/core-types"

export type FetchLike = typeof fetch

export interface LlmProviderConfig {
  /** 本地 provider ID，例如 openai / anthropic / deepseek。 */
  id: ProviderId
  /** 适配器类型。不要把厂商实现细节塞进名字里。 */
  kind: ProviderKind
  displayName: string
  enabled: boolean
  /** 远端 API 根地址。OpenAI 兼容服务通常以 /v1 结尾。 */
  baseUrl: string
  /** V1 单人本地软件先允许内存/环境变量注入，后面再接 Tauri secret store。 */
  apiKey?: string
  /** 某些 provider 需要额外 header，例如 OpenRouter 的 Referer。 */
  headers?: Record<string, string>
  /** 静态兜底模型。远端 listModels 失败时仍可让 UI 有可选项。 */
  staticModels?: ModelDescriptor[]
  /** 内部 modelId 到远端真实 model 名的映射。 */
  modelAliases?: Record<string, string>
  /** 测试或特殊运行环境注入 fetch；正常运行使用 globalThis.fetch。 */
  fetch?: FetchLike
}

export interface LlmStreamRequest extends ChatCompletionRequest {
  providerId: ProviderId
}

export interface LlmAdapter {
  readonly kind: ProviderKind
  readonly displayName: string
  createDescriptor(config: LlmProviderConfig): ProviderDescriptor
  listModels(config: LlmProviderConfig): Promise<ModelDescriptor[]>
  checkHealth(config: LlmProviderConfig): Promise<ProviderHealthView>
  streamChat(config: LlmProviderConfig, request: LlmStreamRequest): AsyncIterable<ChatCompletionChunk>
}

export interface LlmAdapterContext {
  fetch?: FetchLike
}

export interface LlmRegistryOptions {
  adapters?: LlmAdapter[]
  providers?: LlmProviderConfig[]
  fetch?: FetchLike
}

export interface ModelBinding {
  role: ModelRole
  providerId: ProviderId
  modelId: ModelId
}

export type ModelBindingConfig = Partial<Record<ModelRole, ModelBinding>>

export interface LlmConfigSnapshot {
  providers: LlmProviderConfig[]
  bindings: ModelBindingConfig
}

export interface LlmFailure {
  code: UiErrorCode
  message: string
  retryable: boolean
}

export const TEXT_MODEL_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  tools: false,
  vision: false,
  structuredOutput: false,
  promptCache: false,
  listModels: true,
  tts: false,
  stt: false,
  imageGen: false,
  videoGen: false,
  moderation: false,
}

export const TOOL_MODEL_CAPABILITIES: ModelCapabilities = {
  ...TEXT_MODEL_CAPABILITIES,
  tools: true,
  structuredOutput: true,
}
