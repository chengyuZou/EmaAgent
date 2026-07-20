// 定义供应商目录、能力、协议、认证和模型来源，不包含数据库或具体 API 调用行为。

export type Capability = 'llm' | 'embed' | 'rerank' | 'vision' | 'tts' | 'stt';

export const PROTOCOL_FAMILIES = [
  'openai-llm',
  'openai-responses-llm',
  'anthropic-llm',
  'gemini-llm',
  'openai-embed',
  'gemini-embed',
  'cohere-rerank',
  'openai-vision',
  'anthropic-vision',
  'gemini-vision',
  'openai-tts',
  'dashscope-tts',
  'gpt-sovits-tts',
  'openai-stt',
] as const;

export type ProtocolFamily = typeof PROTOCOL_FAMILIES[number];

export type LlmProtocol = Extract<ProtocolFamily, `${string}-llm`>;
export type EmbedProtocol = Extract<ProtocolFamily, `${string}-embed`>;
export type RerankProtocol = Extract<ProtocolFamily, `${string}-rerank`>;
export type VisionProtocol = Extract<ProtocolFamily, `${string}-vision`>;
export type TtsProtocol = Extract<ProtocolFamily, `${string}-tts`>;
export type SttProtocol = Extract<ProtocolFamily, `${string}-stt`>;

/** 供应商有时提供不止一个端点
 * 比如 `DeepSeek` 同时提供了 `OpenAI` 和 `Anthropic` 的 LLM 端点，用户可以选择使用哪一个
 */
export interface ProviderTransport<TProtocol extends ProtocolFamily = ProtocolFamily> {
  protocol: TProtocol;
  /** 仅当该协议不使用供应商默认地址时填写。 */
  baseUrl?: string;
}


export type ProviderModelSource =
  /** 
   * `llm` 与 `vision` 会从 `models-dev` 那里远程拉取每个供应商下的模型
   */
  | { type: 'models-dev'; providerId: string }
  | { type: 'static'; models: readonly string[] }
  | { type: 'live' }
  | { type: 'manual' };

export interface ProviderModelCatalogDefinition {
  sources: readonly ProviderModelSource[];
}

export interface ProviderCapabilityDefinition<
  TProtocol extends ProtocolFamily = ProtocolFamily,
> {
  transports: readonly ProviderTransport<TProtocol>[];
  models?: ProviderModelCatalogDefinition;
}

export interface ProviderCapabilityDefinitions {
  llm?: ProviderCapabilityDefinition<LlmProtocol>;
  embed?: ProviderCapabilityDefinition<EmbedProtocol>;
  rerank?: ProviderCapabilityDefinition<RerankProtocol>;
  vision?: ProviderCapabilityDefinition<VisionProtocol>;
  tts?: ProviderCapabilityDefinition<TtsProtocol>;
  stt?: ProviderCapabilityDefinition<SttProtocol>;
}

export type ProviderAuthDefinition =
  | { type: 'none' }
  | { type: 'bearer'; required: boolean };

export interface ProviderOnboardingField {
  key: string;
  type: 'text' | 'password';
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
}

export interface ProviderDefinition {
  /** 写入数据库的稳定供应商定义 ID。 */
  id: string;
  name: string;
  branding: {
    /** 与具体 UI 图标库无关的稳定图标身份。 */
    iconId: string;
  };
  connection: {
    defaultBaseUrl?: string;
    auth: ProviderAuthDefinition;
  };
  capabilities: ProviderCapabilityDefinitions;
  onboarding?: {
    fields: readonly ProviderOnboardingField[];
  };
}

export type ProviderCredentialOperation =
  | { type: 'keep' }
  | { type: 'replace'; value: string }
  | { type: 'clear' };

export const PROVIDER_CONFIG_LIMITS = Object.freeze({
  apiKeyChars: 8_192,
  baseUrlChars: 2_048,
});

export function defineProvider<const T extends ProviderDefinition>(definition: T): T {
  return definition;
}

export function defineLlmCapability<
  const T extends ProviderCapabilityDefinition<LlmProtocol>,
>(definition: T): T {
  return definition;
}

export function defineEmbedCapability<
  const T extends ProviderCapabilityDefinition<EmbedProtocol>,
>(definition: T): T {
  return definition;
}

export function defineRerankCapability<
  const T extends ProviderCapabilityDefinition<RerankProtocol>,
>(definition: T): T {
  return definition;
}

export function defineVisionCapability<
  const T extends ProviderCapabilityDefinition<VisionProtocol>,
>(definition: T): T {
  return definition;
}

export function defineTtsCapability<
  const T extends ProviderCapabilityDefinition<TtsProtocol>,
>(definition: T): T {
  return definition;
}

export function defineSttCapability<
  const T extends ProviderCapabilityDefinition<SttProtocol>,
>(definition: T): T {
  return definition;
}
