// 声明 SiliconFlow 重排序线路和推荐模型。
import type { ProviderCapability } from '../../types.js';

export const siliconFlowRerank = {
  protocols: [{ protocol: 'cohere-rerank' }],
  catalog: { staticModels: ['BAAI/bge-reranker-v2-m3'] },
} satisfies ProviderCapability<'cohere-rerank'>;
