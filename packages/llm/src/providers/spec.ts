import type { ProviderId, ProviderKind } from "@ema-agent/core-types"

/**
 * Provider 的序列化配置——可存入 SQLite、可通过 HTTP 传输。
 * V1 apiKey 明文存储，V2 接 Tauri Stronghold 时只替换读写层。
 */
export interface LlmProviderSpec {
  id: ProviderId
  kind: ProviderKind
  displayName: string
  enabled: boolean
  /** API 根地址，不含路径（如 https://api.openai.com/v1）。 */
  baseUrl: string
  /** V1 明文存储。未设置时走无鉴权或环境变量兜底。 */
  apiKey?: string
  /** 厂商专属附加请求头（如 OpenRouter 的 HTTP-Referer）。 */
  headers?: Record<string, string>
}

/** applyConfig() 的入参——一批 provider 配置。 */
export interface LlmConfig {
  providers: LlmProviderSpec[]
}
