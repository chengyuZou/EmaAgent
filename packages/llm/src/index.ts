// ── 클라이언트 (唯一对外门面) ──
export { LlmClient } from "./client.js"
export type { LlmChatRequest } from "./client.js"

// ── Provider 配置 ──
export type { LlmConfig, LlmProviderSpec } from "./providers/spec.js"
export { ProviderCatalog } from "./providers/catalog.js"
export {
  createDefaultConfig,
  createOpenAiSpec,
  createAnthropicSpec,
  createGeminiSpec,
  createDeepSeekSpec,
  createOpenRouterSpec,
  createOllamaSpec,
} from "./providers/presets.js"

// ── 模型目录 ──
export { ModelCatalog } from "./models/catalog.js"
export { fetchModels } from "./models/fetch.js"

// ── 用量与错误 ──
export { estimateUsageCost } from "./usage/cost.js"
export { isToolUnsupportedError, normalizeProviderError, TOOL_UNSUPPORTED_PATTERNS } from "./usage/errors.js"
