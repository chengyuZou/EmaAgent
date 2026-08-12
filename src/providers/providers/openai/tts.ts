// 声明 OpenAI 语音合成线路和离线推荐模型。
import type { ProviderCapability } from '../../types.js';

export const openAiTts = {
  protocols: [{ protocol: 'openai-tts' }],
  catalog: { staticModels: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
} satisfies ProviderCapability<'openai-tts'>;
