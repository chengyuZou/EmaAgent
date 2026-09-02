export const MODEL_CAPABILITIES = ['llm', 'embed', 'rerank', 'vision', 'tts', 'stt'] as const;

export type ModelCapability = typeof MODEL_CAPABILITIES[number];

export const PROTOCOLS = [
  'openai-llm',
  'openai-responses-llm',
  'anthropic-llm',
  'gemini-llm',
  'openai-embed',
  'gemini-embed',
  'cohere-rerank',
  'openai-tts',
  'dashscope-tts',
  'gpt-sovits-tts',
  'openai-stt',
] as const;

export type Protocol = typeof PROTOCOLS[number];
export type LlmProtocol = Extract<Protocol, `${string}-llm`>;
export type EmbedProtocol = Extract<Protocol, `${string}-embed`>;
export type RerankProtocol = Extract<Protocol, `${string}-rerank`>;
export type TtsProtocol = Extract<Protocol, `${string}-tts`>;
export type SttProtocol = Extract<Protocol, `${string}-stt`>;

/** 存储层只存普通 string；词表守卫：不在 LlmProtocol 词表内返回 false（不伪造来源）。 */
export function isLlmProtocol(value: string): value is LlmProtocol {
  return (PROTOCOLS as readonly string[]).includes(value) && value.endsWith('-llm');
}

export interface ModelCapabilityProtocolMap {
  llm: LlmProtocol;
  embed: EmbedProtocol;
  rerank: RerankProtocol;
  /** Vision 是一次无 Tool 的多模态 LLM 调用，直接复用已经实现的 LLM 协议。 */
  vision: LlmProtocol;
  tts: TtsProtocol;
  stt: SttProtocol;
}

export type ModelCapabilityProtocol<TModelCapability extends ModelCapability> =
  ModelCapabilityProtocolMap[TModelCapability];

/** Provider 解析出的连接可直接传给对应 API 包，不包含请求执行状态。 */
export interface ProviderConnection<TModelCapability extends ModelCapability> {
  /** 连接归属的 Provider 身份；Adapter 用它做生成来源三元匹配（providerId+modelId+protocol）。 */
  providerId: string;
  protocol: ModelCapabilityProtocol<TModelCapability>;
  baseUrl: string;
  apiKey?: string;
}

export const PROVIDER_LIMITS = Object.freeze({
  idChars: 64,
  apiKeyChars: 8_192,
  baseUrlChars: 2_048,
  nameChars: 120,
});

export function isProtocolForCapability<TCapability extends ModelCapability>(
  capability: TCapability,
  protocol: Protocol,
): protocol is ModelCapabilityProtocol<TCapability> {
  switch (capability) {
    case 'llm':
      return protocol === 'openai-llm'
        || protocol === 'openai-responses-llm'
        || protocol === 'anthropic-llm'
        || protocol === 'gemini-llm';
    case 'embed':
      return protocol === 'openai-embed' || protocol === 'gemini-embed';
    case 'rerank':
      return protocol === 'cohere-rerank';
    case 'vision':
      return protocol === 'openai-llm'
        || protocol === 'openai-responses-llm'
        || protocol === 'anthropic-llm'
        || protocol === 'gemini-llm';
    case 'tts':
      return protocol === 'openai-tts'
        || protocol === 'dashscope-tts'
        || protocol === 'gpt-sovits-tts';
    case 'stt':
      return protocol === 'openai-stt';
  }
}
