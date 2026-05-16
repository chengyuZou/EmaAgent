// ── Capability + Protocol ────────────────────────────────────────────────────

/**
 * What a provider can do. The maximum surface — a given user can enable
 * a subset for any specific provider config.
 */
export type Capability = 'llm' | 'embed' | 'rerank' | 'vision' | 'tts' | 'stt';

/**
 * Capabilities that go through `capability_bindings` (singleton per capability).
 * 'llm' is excluded because it's bound via `model_bindings` per module
 * (chat / narrative / agent / etc.) instead.
 */
export type BindableCapability = Exclude<Capability, 'llm'>;

/**
 * Wire-format protocol families. Names follow the pattern
 *   `{capability}-{format-origin}`
 * to stay honest about which capability uses which body/response shape.
 *
 * Only protocols we actually have an implementation for are listed here.
 * Adding a new entry MUST come with a corresponding adapter in `packages/llm`
 * (for *-llm) or `apps/bridge` (for embed/rerank/etc).
 */
export type ProtocolFamily =
  // LLM protocols
  | 'openai-llm'        // /v1/chat/completions, { messages: [...] }
  | 'anthropic-llm'     // /messages, system extracted
  | 'gemini-llm'        // /generateContent, parts structure
  // Embedding protocols
  | 'openai-embed'      // /v1/embeddings, { model, input: string[] }
  // Rerank protocols
  | 'cohere-rerank';    // /rerank, { model, query, documents, top_n } — Cohere/Jina/SiliconFlow all use this

/**
 * LLM-specific subset of ProtocolFamily — the adapter dispatch key
 * used by `LlmRouter`. Derived so `LlmProtocol` automatically stays in sync
 * if a new `*-llm` is added to ProtocolFamily.
 */
export type LlmProtocol = Extract<ProtocolFamily, `${string}-llm`>;

/** Type guard for narrowing ProtocolFamily down to LlmProtocol. */
export function isLlmProtocol(p: ProtocolFamily | undefined): p is LlmProtocol {
  return p === 'openai-llm' || p === 'anthropic-llm' || p === 'gemini-llm';
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
  /** Pre-filled base URL; user can override per provider_config. */
  defaultBaseUrl?: string;
  /** Maximum set of capabilities this provider offers. */
  capabilities: readonly Capability[];
  /**
   * Protocol used for each capability. Only declare capabilities you intend
   * to expose AND have an adapter for.
   */
  protocols: Partial<Record<Capability, ProtocolFamily>>;
  /** Recommended models per capability — shown in the model picker. */
  defaultModels?: Partial<Record<Capability, readonly string[]>>;
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
