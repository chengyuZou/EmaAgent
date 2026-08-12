// 声明 SiliconFlow 图像理解线路和经过筛选的推荐模型。
import type { ProviderCapability } from '../../types.js';

export const siliconFlowVision = {
  protocols: [{ protocol: 'openai-vision' }],
  catalog: {
    modelsDevId: 'siliconflow',
    staticModels: ['Qwen/Qwen2-VL-72B-Instruct', 'Pro/Qwen/Qwen2.5-VL-7B-Instruct'],
  },
} satisfies ProviderCapability<'openai-vision'>;
