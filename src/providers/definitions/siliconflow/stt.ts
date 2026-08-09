// 声明 SiliconFlow 语音识别线路和推荐模型。
import type { ProviderCapabilityDefinition } from '../../types.js';

export const siliconFlowStt = {
  transports: [{ protocol: 'openai-stt' }],
  models: { staticModels: ['FunAudioLLM/SenseVoiceSmall'] },
} satisfies ProviderCapabilityDefinition<'openai-stt'>;
