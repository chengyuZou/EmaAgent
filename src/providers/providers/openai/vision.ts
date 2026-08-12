// 声明 OpenAI 图像理解线路和可用模型来源。
import type { ProviderCapability } from '../../types.js';

export const openAiVision = {
  protocols: [{ protocol: 'openai-vision' }],
  catalog: {
    modelsDevId: 'openai',
    staticModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
  },
} satisfies ProviderCapability<'openai-vision'>;
