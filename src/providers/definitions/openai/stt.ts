// 声明 OpenAI 语音识别线路和离线推荐模型。
import { defineSttCapability } from '../../types.js';

export const openAiStt = defineSttCapability({
  transports: [{ protocol: 'openai-stt' }],
  models: {
    sources: [
      { type: 'static', models: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'] },
      { type: 'manual' },
    ],
  },
});
