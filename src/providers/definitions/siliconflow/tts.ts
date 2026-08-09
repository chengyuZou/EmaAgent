// 声明 SiliconFlow 语音合成线路和推荐模型。
import type { ProviderCapabilityDefinition } from '../../types.js';

export const siliconFlowTts = {
  transports: [{ protocol: 'openai-tts' }],
  models: { staticModels: ['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5'] },
} satisfies ProviderCapabilityDefinition<'openai-tts'>;
