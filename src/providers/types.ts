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

export interface CapabilityProtocolMap {
  llm: LlmProtocol;
  embed: EmbedProtocol;
  rerank: RerankProtocol;
  vision: VisionProtocol;
  tts: TtsProtocol;
  stt: SttProtocol;
}

export type CapabilityProtocol<TCapability extends Capability> =
  CapabilityProtocolMap[TCapability];

/** Provider 解析出的连接可直接传给对应 API 包，不包含请求执行状态。 */
export interface ProviderConnection<TCapability extends Capability> {
  protocol: CapabilityProtocol<TCapability>;
  baseUrl: string;
  apiKey?: string;
}

export interface ProviderTransport<TProtocol extends ProtocolFamily = ProtocolFamily> {
  protocol: TProtocol;
  /** 仅当该协议不使用 Provider 默认地址时填写。 */
  baseUrl?: string;
}

/** 内置目录只提供模型建议；手动添加模型是所有 Provider 的通用能力。 */
export interface ProviderModelCatalogDefinition {
  modelsDevId?: string;
  staticModels?: readonly string[];
  supportsLiveListing?: boolean;
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

export interface ProviderDefinition {
  /** 内置预设的稳定身份；用户自定义连接不伪造 Definition。 */
  id: string;
  name: string;
  branding: {
    iconId: string;
  };
  connection: {
    defaultBaseUrl?: string;
    auth: ProviderAuthDefinition;
  };
  capabilities: ProviderCapabilityDefinitions;
}

export type ProviderCredentialOperation =
  | { type: 'keep' }
  | { type: 'replace'; value: string }
  | { type: 'clear' };

export const PROVIDER_CONFIG_LIMITS = Object.freeze({
  apiKeyChars: 8_192,
  baseUrlChars: 2_048,
  displayNameChars: 120,
});

export function defineProvider<const T extends ProviderDefinition>(definition: T): T {
  return definition;
}
