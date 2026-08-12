// 声明 OpenAI 语音识别线路和离线推荐模型。
import type { ProviderCapability } from '../../types.js';

export const openAiStt = {
  protocols: [{ protocol: 'openai-stt' }],
  catalog: { staticModels: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'] },
} satisfies ProviderCapability<'openai-stt'>;
