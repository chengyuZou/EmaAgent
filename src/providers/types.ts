// 模型能力：六个执行面入口(LLM / 嵌入 / 重排 / 视觉 / 语音合成 / 语音识别) 未来可加入imagegen / 视频等 等更新吧
export type ModelCapability = 'llm' | 'embed' | 'rerank' | 'vision' | 'tts' | 'stt';

export const PROTOCOLS = [
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

export type Protocol = typeof PROTOCOLS[number];
export type LlmProtocol = Extract<Protocol, `${string}-llm`>;
export type EmbedProtocol = Extract<Protocol, `${string}-embed`>;
export type RerankProtocol = Extract<Protocol, `${string}-rerank`>;
export type VisionProtocol = Extract<Protocol, `${string}-vision`>;
export type TtsProtocol = Extract<Protocol, `${string}-tts`>;
export type SttProtocol = Extract<Protocol, `${string}-stt`>;

export interface ModelCapabilityProtocolMap {
  llm: LlmProtocol;
  embed: EmbedProtocol;
  rerank: RerankProtocol;
  vision: VisionProtocol;
  tts: TtsProtocol;
  stt: SttProtocol;
}

export type ModelCapabilityProtocol<TModelCapability extends ModelCapability> =
  ModelCapabilityProtocolMap[TModelCapability];

/** Provider 解析出的连接可直接传给对应 API 包，不包含请求执行状态。 */
export interface ProviderConnection<TModelCapability extends ModelCapability> {
  protocol: ModelCapabilityProtocol<TModelCapability>;
  baseUrl: string;
  apiKey?: string;
}

/** 预设中某一能力下的一档可选协议；baseUrl 仅当该档不走预设默认地址时填写。 */
export interface ProviderProtocolOption<TProtocol extends Protocol = Protocol> {
  protocol: TProtocol;
  baseUrl?: string;
}

/** 内置目录只提供模型建议；手动添加模型是所有 Provider 的通用能力。 */
export interface ProviderModelCatalogSource {
  modelsDevId?: string;
  staticModels?: readonly string[];
  supportsLiveListing?: boolean;
}

/** 预设中单个能力的声明：可选协议档位与模型建议来源。 */
export interface ProviderCapability<
  TProtocol extends Protocol = Protocol,
> {
  protocols: readonly ProviderProtocolOption<TProtocol>[];
  catalog?: ProviderModelCatalogSource;
}

/** 预设的全部能力声明，按能力分键。 */
export interface ProviderCapabilities {
  llm?: ProviderCapability<LlmProtocol>;
  embed?: ProviderCapability<EmbedProtocol>;
  rerank?: ProviderCapability<RerankProtocol>;
  vision?: ProviderCapability<VisionProtocol>;
  tts?: ProviderCapability<TtsProtocol>;
  stt?: ProviderCapability<SttProtocol>;
}

export type ProviderAuth =
  | { type: 'none' }
  | { type: 'bearer'; required: boolean };

export interface Provider {
  /** 内置预设的稳定身份；用户自定义连接不伪造预设。 */
  id: string;
  name: string;
  branding: {
    iconId: string;
  };
  connection: {
    defaultBaseUrl?: string;
    auth: ProviderAuth;
  };
  capabilities: ProviderCapabilities;
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

export function defineProvider<const T extends Provider>(provider: T): T {
  return provider;
}
