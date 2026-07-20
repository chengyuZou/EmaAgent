// 声明 SiliconFlow 语音识别线路和推荐模型。
import { defineSttCapability } from '../../types.js';

export const siliconFlowStt = defineSttCapability({
  transports: [{ protocol: 'openai-stt' }],
  models: {
    sources: [
      { type: 'static', models: ['FunAudioLLM/SenseVoiceSmall'] },
      { type: 'manual' },
    ],
  },
});
