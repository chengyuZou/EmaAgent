// 声明 OpenAI 语音识别线路和离线推荐模型。
import type { ProviderCapabilityDefinition } from '../../types.js';

export const openAiStt = {
  transports: [{ protocol: 'openai-stt' }],
  models: { staticModels: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'] },
} satisfies ProviderCapabilityDefinition<'openai-stt'>;
