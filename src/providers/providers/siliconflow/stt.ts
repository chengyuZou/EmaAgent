// 声明 SiliconFlow 语音识别线路和推荐模型。
import type { ProviderCapability } from '../../types.js';

export const siliconFlowStt = {
  protocols: [{ protocol: 'openai-stt' }],
  catalog: { staticModels: ['FunAudioLLM/SenseVoiceSmall'] },
} satisfies ProviderCapability<'openai-stt'>;
