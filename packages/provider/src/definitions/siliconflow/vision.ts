// 声明 SiliconFlow 图像理解线路和经过筛选的推荐模型。
import { defineVisionCapability } from '../../types.js';

export const siliconFlowVision = defineVisionCapability({
  transports: [{ protocol: 'openai-vision' }],
  models: {
    sources: [
      { type: 'models-dev', providerId: 'siliconflow' },
      { type: 'static', models: ['Qwen/Qwen2-VL-72B-Instruct', 'Pro/Qwen/Qwen2.5-VL-7B-Instruct'] },
      { type: 'manual' },
    ],
  },
});
