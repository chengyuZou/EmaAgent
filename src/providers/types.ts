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

/**
 * 同一供应商可能同时提供多种协议兼容端点。
 * 例如 DeepSeek 的 LLM 可以按用户配置选择 OpenAI 或 Anthropic 协议。
 */
export interface ProviderTransport<TProtocol extends ProtocolFamily = ProtocolFamily> {
  protocol: TProtocol;
  /** 仅当该协议不使用供应商默认地址时填写。 */
  baseUrl?: string;
}

export type ProviderModelSource =
  /** LLM 与 Vision 通过 models.dev 获取供应商模型目录。 */
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
  /** 同一能力可声明多种兼容协议，最终使用哪一种由用户的能力配置决定。 */
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
  /** 写入数据库和模型绑定的稳定身份，发布后不能随显示名称一起改动。 */
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
