// 声明 OpenAI 向量模型线路和离线推荐模型。
import type { ProviderCapability } from '../../types.js';

export const openAiEmbedding = {
  protocols: [{ protocol: 'openai-embed' }],
  catalog: { staticModels: ['text-embedding-3-small', 'text-embedding-3-large'] },
} satisfies ProviderCapability<'openai-embed'>;
