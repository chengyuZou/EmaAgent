// ── Capability + Protocol ────────────────────────────────────────────────────

/**
 * What a provider can do. The maximum surface — a given user can enable
 * a subset for any specific provider config.
 */
export type Capability = 'llm' | 'embed' | 'rerank' | 'vision' | 'tts' | 'stt';

/**
 * 修改 Provider 凭据时的显式操作。
 * 不再用 undefined 或空字符串猜测用户意图，避免编辑其他字段时误删密钥。
 */
export type ProviderCredentialOperation =
  | { type: 'keep' }
  | { type: 'replace'; value: string }
  | { type: 'clear' };

/** Provider 配置字段的前后端统一长度上限。 */
export const PROVIDER_CONFIG_LIMITS = Object.freeze({
  apiKeyChars: 8_192,
  baseUrlChars: 2_048,
});

/**
 * Wire-format protocol families. Names follow the pattern
 *   `{capability}-{format-origin}`
 * to stay honest about which capability uses which body/response shape.
 *
 * Only protocols we actually have an implementation for are listed here.
 * Adding a new entry MUST come with a corresponding adapter in the package that
 * owns that capability, e.g. `packages/llm` for `*-llm` or `packages/vision`
 * for `*-vision`.
 */
export type ProtocolFamily =
  // LLM protocols
  | 'openai-llm'            // /v1/chat/completions, { messages: [...] }
  | 'openai-responses-llm'  // /v1/responses — per-tool done events, o-series reasoning
  | 'anthropic-llm'         // /messages, system extracted
  | 'gemini-llm'            // /generateContent, parts structure
  // Embedding protocols
  | 'openai-embed'      // /v1/embeddings, { model, input: string[] }
  | 'gemini-embed'      // /v1beta/models/{model}:batchEmbedContents, Google format
  // Rerank protocols
  | 'cohere-rerank'     // /rerank, { model, query, documents, top_n } — Cohere/Jina/SiliconFlow all use this
  // Vision protocols
  | 'openai-vision'     // /v1/chat/completions multimodal content parts — OpenAI-compatible vision models
  | 'anthropic-vision'  // /messages with image blocks — Anthropic SDK native
  | 'gemini-vision'     // generateContent with inlineData parts — Google GenAI SDK native
  // TTS protocols
  | 'openai-tts'        // POST /v1/audio/speech — OpenAI / SiliconFlow / Groq / OpenAI 兼容
  | 'dashscope-tts'     // 阿里百炼 WS — adapter routes by model prefix (cosyvoice-* | qwen*-tts*)
  | 'gpt-sovits-tts'    // POST /tts on a locally-running GPT-SoVITS api_v2.py server
  // STT protocols
  | 'openai-stt';       // POST /v1/audio/transcriptions — Whisper protocol

/**
 * LLM-specific subset of ProtocolFamily — the adapter dispatch key
 * used by `LlmRouter`. Derived so `LlmProtocol` automatically stays in sync
 * if a new `*-llm` is added to ProtocolFamily.
 */
export type LlmProtocol    = Extract<ProtocolFamily, `${string}-llm`>;
export type EmbedProtocol  = Extract<ProtocolFamily, `${string}-embed`>;
export type RerankProtocol = Extract<ProtocolFamily, `${string}-rerank`>;
export type VisionProtocol = Extract<ProtocolFamily, `${string}-vision`>;
export type TtsProtocol    = Extract<ProtocolFamily, `${string}-tts`>;
export type SttProtocol    = Extract<ProtocolFamily, `${string}-stt`>;

/** Type guard for narrowing ProtocolFamily down to LlmProtocol. */
export function isLlmProtocol(p: ProtocolFamily | undefined): p is LlmProtocol {
  return p === 'openai-llm'
      || p === 'openai-responses-llm'
      || p === 'anthropic-llm'
      || p === 'gemini-llm';
}

export function isEmbedProtocol(p: ProtocolFamily | undefined): p is EmbedProtocol {
  return p === 'openai-embed' || p === 'gemini-embed';
}

export function isRerankProtocol(p: ProtocolFamily | undefined): p is RerankProtocol {
  return p === 'cohere-rerank';
}

export function isVisionProtocol(p: ProtocolFamily | undefined): p is VisionProtocol {
  return p === 'openai-vision' || p === 'anthropic-vision' || p === 'gemini-vision';
}

export function isTtsProtocol(p: ProtocolFamily | undefined): p is TtsProtocol {
  return p === 'openai-tts' || p === 'dashscope-tts' || p === 'gpt-sovits-tts';
}

export function isSttProtocol(p: ProtocolFamily | undefined): p is SttProtocol {
  return p === 'openai-stt';
}

// ── Onboarding fields ────────────────────────────────────────────────────────

/**
 * Field descriptor for the credential input form rendered by the settings UI.
 * Lets a provider declare extra fields beyond the standard apiKey + baseUrl
 * (e.g. Azure OpenAI needs a resourceName).
 */
export interface ProviderOnboardingField {
  key: string;
  type: 'text' | 'password';
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
}

// ── Provider definition ──────────────────────────────────────────────────────

export interface ProviderDefinition {
  /** Stable string ID stored in DB. Lowercase, kebab-case. Must equal the folder name. */
  id: string;
  /** Display name in the settings UI. */
  name: string;
  /**
   * Default base URL for the primary protocol. When a provider uses different
   * endpoints per protocol, use `protocolBaseUrls` instead.
   */
  defaultBaseUrl?: string;
  /**
   * Per-protocol base URLs. Takes precedence over `defaultBaseUrl` when the
   * user selects a specific protocol. Useful when a provider exposes the same
   * models at different endpoints for different wire formats (e.g. DeepSeek
   * has `/v1/...` for OpenAI and `/anthropic/...` for Anthropic).
   */
  protocolBaseUrls?: Partial<Record<ProtocolFamily, string>>;
  /** Maximum set of capabilities this provider offers. */
  capabilities: readonly Capability[];
  /**
   * Protocol(s) supported for each capability. A single value means only one
   * protocol is available; an array lets the user pick when adding a config.
   * Only declare capabilities you intend to expose AND have an adapter for.
   */
  protocols: Partial<Record<Capability, ProtocolFamily | readonly ProtocolFamily[]>>;
  /**
   * Recommended models per capability — shown in the model picker.
   * @deprecated Superseded by the models.dev catalog (see `modelsDevId`) for LLM
   * model lists + context/capability metadata. Kept as an offline fallback only;
   * remove once the catalog fetch pipeline is the sole source.
   */
  defaultModels?: Partial<Record<Capability, readonly string[]>>;
  /**
   * models.dev provider folder id, used to pull LLM/Vision model lists +
   * context window + modalities/tool_call/reasoning/temperature from the
   * models.dev catalog (https://models.dev/api.json) instead of hardcoding.
   *
   * Omit for providers models.dev doesn't track (local runtimes, embed/rerank/
   * tts-only providers) — those fall back to the provider's own `/models`
   * endpoint or manual entry.
   */
  modelsDevId?: string;
  /** Icon hint, e.g. `i-lobe-icons:deepseek`. Frontend maps to actual asset. */
  iconKey?: string;
  /** Icon variant for colored logo. */
  iconColor?: string;
  /**
   * Whether the user must supply credentials. Local runtimes (Ollama,
   * LM Studio) set this to false so the settings UI hides the API key field.
   * @default true
   */
  requiresCredentials?: boolean;
  /**
   * Extra credential fields beyond the standard {apiKey, baseUrl}.
   * The frontend renders these as inputs on the provider's edit page.
   * Field values are stored in `provider_configs.config_json`.
   */
  onboardingFields?: readonly ProviderOnboardingField[];
}

// ── defineProvider helper ────────────────────────────────────────────────────

/**
 * Identity helper that preserves literal types via `const` generic.
 * Use in every provider's `index.ts` for consistent typing.
 *
 * @example
 *   export const provider = defineProvider({
 *     id: 'openai',
 *     name: 'OpenAI',
 *     capabilities: ['llm', 'embed'],   // ← inferred as readonly tuple, not Capability[]
 *     ...
 *   });
 */
export function defineProvider<const T extends ProviderDefinition>(def: T): T {
  return def;
}

/**
 * Normalise a protocol declaration to an array.
 * Single value → [value]; array → array; undefined → [].
 *
 * @example
 *   resolveProtocols(def.protocols.llm)
 *   // 'openai-llm'                      → ['openai-llm']
 *   // ['openai-llm', 'anthropic-llm']   → ['openai-llm', 'anthropic-llm']
 *   // undefined                          → []
 */
export function resolveProtocols(
  proto: ProtocolFamily | readonly ProtocolFamily[] | undefined,
): ProtocolFamily[] {
  if (!proto) return [];
  return Array.isArray(proto) ? [...proto] : [proto as ProtocolFamily];
}

/**
 * Resolve the default base URL for a given protocol choice.
 * Checks `protocolBaseUrls` first, falls back to `defaultBaseUrl`.
 */
export function resolveBaseUrl(
  def: ProviderDefinition,
  protocol?: ProtocolFamily,
): string | undefined {
  if (protocol && def.protocolBaseUrls?.[protocol]) {
    return def.protocolBaseUrls[protocol];
  }
  return def.defaultBaseUrl;
}
