// 声明 SiliconFlow 重排序线路和推荐模型。
import type { ProviderCapabilityDefinition } from '../../types.js';

export const siliconFlowRerank = {
  transports: [{ protocol: 'cohere-rerank' }],
  models: { staticModels: ['BAAI/bge-reranker-v2-m3'] },
} satisfies ProviderCapabilityDefinition<'cohere-rerank'>;
