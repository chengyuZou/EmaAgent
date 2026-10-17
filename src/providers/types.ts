import type { ModelCapabilityRow, ModelBindingModuleRow } from '@ema-agent/storage';

export const MODEL_CAPABILITIES = ['llm', 'embed', 'rerank', 'vision', 'tts', 'stt'] as const;

export type ModelCapability = ModelCapabilityRow;

export const PROTOCOLS = [
  'openai-llm',
  'openai-responses-llm',
  'anthropic-llm',
  'gemini-llm',
  'openai-embed',
  'gemini-embed',
  'cohere-rerank',
  'siliconflow-tts',
  'dashscope-tts',
  'gpt-sovits-tts',
  'openai-stt',
] as const;

export type Protocol = typeof PROTOCOLS[number];
export type LLMProtocol = Extract<Protocol, `${string}-llm`>;
export type EmbedProtocol = Extract<Protocol, `${string}-embed`>;
export type RerankProtocol = Extract<Protocol, `${string}-rerank`>;
export type TTSProtocol = Extract<Protocol, `${string}-tts`>;
export type STTProtocol = Extract<Protocol, `${string}-stt`>;

/** 存储层的协议字段是 string, 读取后先检查它是否属于支持的 LLM 协议. */
export function isLLMProtocol(value: string): value is LLMProtocol {
  return (PROTOCOLS as readonly string[]).includes(value) && value.endsWith('-llm');
}

export interface ModelCapabilityProtocolMap {
  llm: LLMProtocol;
  embed: EmbedProtocol;
  rerank: RerankProtocol;
  /** Vision 使用同一组 LLM 协议, 但单独保存连接和模型绑定. */
  vision: LLMProtocol;
  tts: TTSProtocol;
  stt: STTProtocol;
}

export type ModelCapabilityProtocol<TModelCapability extends ModelCapability> =
  ModelCapabilityProtocolMap[TModelCapability];

export interface ProviderConnection<TModelCapability extends ModelCapability> {
  /** 与 modelId 和 protocol 一起确定生成来源, 用于判断历史内容能否原样回传. */
  providerId: string;
  protocol: ModelCapabilityProtocol<TModelCapability>;
  baseUrl: string;
  apiKey?: string;
}

export type ModelBindingModule = ModelBindingModuleRow;

export const MODEL_BINDING_CAPABILITIES: Readonly<Record<ModelBindingModule, ModelCapability>> =
  Object.freeze({
    'memory-llm': 'llm',
    'narrative-llm': 'llm',
    'narrative-embed': 'embed',
    'narrative-rerank': 'rerank',
    'tts': 'tts',
    'stt': 'stt',
    'vision': 'vision',
  });

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
      return protocol === 'siliconflow-tts'
        || protocol === 'dashscope-tts'
        || protocol === 'gpt-sovits-tts';
    case 'stt':
      return protocol === 'openai-stt';
  }
}
