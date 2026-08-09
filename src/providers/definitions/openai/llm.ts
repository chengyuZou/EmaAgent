// 声明 OpenAI 文本推理支持的两种线路以及模型目录来源。
import type { ProviderCapabilityDefinition } from '../../types.js';

export const openAiLlm = {
  transports: [
    { protocol: 'openai-llm' },
    { protocol: 'openai-responses-llm' },
  ],
  models: { modelsDevId: 'openai' },
} satisfies ProviderCapabilityDefinition<'openai-llm' | 'openai-responses-llm'>;
