// 声明 SiliconFlow 语音合成线路和推荐模型。
import { defineTtsCapability } from '../../types.js';

export const siliconFlowTts = defineTtsCapability({
  transports: [{ protocol: 'openai-tts' }],
  models: {
    sources: [
      { type: 'static', models: ['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5'] },
      { type: 'manual' },
    ],
  },
});
