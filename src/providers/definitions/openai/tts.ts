// 声明 OpenAI 语音合成线路和离线推荐模型。
import type { ProviderCapabilityDefinition } from '../../types.js';

export const openAiTts = {
  transports: [{ protocol: 'openai-tts' }],
  models: { staticModels: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
} satisfies ProviderCapabilityDefinition<'openai-tts'>;
