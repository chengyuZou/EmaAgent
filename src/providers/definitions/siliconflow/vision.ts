// 声明 SiliconFlow 图像理解线路和经过筛选的推荐模型。
import type { ProviderCapabilityDefinition } from '../../types.js';

export const siliconFlowVision = {
  transports: [{ protocol: 'openai-vision' }],
  models: {
    modelsDevId: 'siliconflow',
    staticModels: ['Qwen/Qwen2-VL-72B-Instruct', 'Pro/Qwen/Qwen2.5-VL-7B-Instruct'],
  },
} satisfies ProviderCapabilityDefinition<'openai-vision'>;
