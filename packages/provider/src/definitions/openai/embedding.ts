// 声明 OpenAI 向量模型线路和离线推荐模型。
import { defineEmbedCapability } from '../../types.js';

export const openAiEmbedding = defineEmbedCapability({
  transports: [{ protocol: 'openai-embed' }],
  models: {
    sources: [
      { type: 'static', models: ['text-embedding-3-small', 'text-embedding-3-large'] },
      { type: 'manual' },
    ],
  },
});
