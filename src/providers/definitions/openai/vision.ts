// 声明 OpenAI 图像理解线路和可用模型来源。
import { defineVisionCapability } from '../../types.js';

export const openAiVision = defineVisionCapability({
  transports: [{ protocol: 'openai-vision' }],
  models: {
    sources: [
      { type: 'models-dev', providerId: 'openai' },
      { type: 'static', models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'] },
      { type: 'manual' },
    ],
  },
});
