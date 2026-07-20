// 声明 OpenAI 语音合成线路和离线推荐模型。
import { defineTtsCapability } from '../../types.js';

export const openAiTts = defineTtsCapability({
  transports: [{ protocol: 'openai-tts' }],
  models: {
    sources: [
      { type: 'static', models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] },
      { type: 'manual' },
    ],
  },
});
