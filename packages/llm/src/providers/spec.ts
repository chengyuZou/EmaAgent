import type { ProviderId, ProviderKind } from "@ema-agent/core-types"

/**
 * Provider 的运行时配置。
 *
 * 注意：这个类型是 LLM 调用层消费的“已解密配置”，不是 SQLite 表行。
 * 最终版本应由 API / storage 层从 provider_configs 读取并解密 key，再组装成
 * LlmProviderSpec 注入 LlmClient；不要把明文 apiKey 持久化到 SQLite。
 */
export interface LlmProviderSpec {
  id: ProviderId
  kind: ProviderKind
  displayName: string
  enabled: boolean
  /** API 根地址，不含路径（如 https://api.openai.com/v1）。 */
  baseUrl: string
  /** 仅运行时内存中的明文 key；持久化层应存 api_key_encrypted 或 credentialId。 */
  apiKey?: string
  /** 厂商专属附加请求头（如 OpenRouter 的 HTTP-Referer）。 */
  headers?: Record<string, string>
}

/** applyConfig() 的入参——一批已从最终配置源加载好的运行时 provider 配置。 */
export interface LlmConfig {
  providers: LlmProviderSpec[]
}
