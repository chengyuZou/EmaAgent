// 声明 SiliconFlow 向量线路，避免从混合模型接口猜测模型类型。
import type { ProviderCapability } from '../../types.js';

export const siliconFlowEmbedding = {
  protocols: [{ protocol: 'openai-embed' }],
  catalog: { staticModels: ['Pro/BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5'] },
} satisfies ProviderCapability<'openai-embed'>;
