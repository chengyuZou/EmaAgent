// 声明 SiliconFlow 向量线路，避免从混合模型接口猜测模型类型。
import { defineEmbedCapability } from '../../types.js';

export const siliconFlowEmbedding = defineEmbedCapability({
  transports: [{ protocol: 'openai-embed' }],
  models: {
    sources: [
      { type: 'static', models: ['Pro/BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5'] },
      { type: 'manual' },
    ],
  },
});
