// 声明 SiliconFlow 文本推理线路和经过能力分类的模型目录来源。
import { defineLlmCapability } from '../../types.js';

export const siliconFlowLlm = defineLlmCapability({
  transports: [{ protocol: 'openai-llm' }],
  models: {
    sources: [
      { type: 'models-dev', providerId: 'siliconflow' },
      { type: 'manual' },
    ],
  },
});
