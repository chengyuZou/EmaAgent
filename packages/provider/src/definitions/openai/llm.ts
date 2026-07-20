// 声明 OpenAI 文本推理支持的两种线路以及模型目录来源。
import { defineLlmCapability } from '../../types.js';

export const openAiLlm = defineLlmCapability({
  transports: [
    { protocol: 'openai-llm' },
    { protocol: 'openai-responses-llm' },
  ],
  models: {
    sources: [
      { type: 'models-dev', providerId: 'openai' },
      { type: 'manual' },
    ],
  },
});
