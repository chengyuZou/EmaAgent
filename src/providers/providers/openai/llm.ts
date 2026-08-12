// 声明 OpenAI 文本推理支持的两种线路以及模型目录来源。
import type { ProviderCapability } from '../../types.js';

export const openAiLlm = {
  protocols: [
    { protocol: 'openai-llm' },
    { protocol: 'openai-responses-llm' },
  ],
  catalog: { modelsDevId: 'openai' },
} satisfies ProviderCapability<'openai-llm' | 'openai-responses-llm'>;
