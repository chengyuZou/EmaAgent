// 声明 SiliconFlow 语音合成线路和推荐模型。
import type { ProviderCapability } from '../../types.js';

export const siliconFlowTts = {
  protocols: [{ protocol: 'openai-tts' }],
  catalog: { staticModels: ['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5'] },
} satisfies ProviderCapability<'openai-tts'>;
