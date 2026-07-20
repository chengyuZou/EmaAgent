// 声明 SiliconFlow 重排序线路和推荐模型。
import { defineRerankCapability } from '../../types.js';

export const siliconFlowRerank = defineRerankCapability({
  transports: [{ protocol: 'cohere-rerank' }],
  models: {
    sources: [
      { type: 'static', models: ['BAAI/bge-reranker-v2-m3'] },
      { type: 'manual' },
    ],
  },
});
