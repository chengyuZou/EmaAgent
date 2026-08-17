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
      return protocol === 'openai-vision'
        || protocol === 'anthropic-vision'
        || protocol === 'gemini-vision';
    case 'tts':
      return protocol === 'openai-tts'
        || protocol === 'dashscope-tts'
        || protocol === 'gpt-sovits-tts';
    case 'stt':
      return protocol === 'openai-stt';
  }
}

/** OpenAI 兼容端点天然支持 GET /models 实时拉取模型清单；其余协议族只能 models.dev 或手填。 */
export function protocolSupportsLiveListing(protocol: Protocol): boolean {
  return protocol.startsWith('openai-');
}
