// 声明 OpenAI 向量模型线路和离线推荐模型。
import type { ProviderCapabilityDefinition } from '../../types.js';

export const openAiEmbedding = {
  transports: [{ protocol: 'openai-embed' }],
  models: { staticModels: ['text-embedding-3-small', 'text-embedding-3-large'] },
} satisfies ProviderCapabilityDefinition<'openai-embed'>;
