// 声明 SiliconFlow 向量线路，避免从混合模型接口猜测模型类型。
import type { ProviderCapabilityDefinition } from '../../types.js';

export const siliconFlowEmbedding = {
  transports: [{ protocol: 'openai-embed' }],
  models: { staticModels: ['Pro/BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5'] },
} satisfies ProviderCapabilityDefinition<'openai-embed'>;
