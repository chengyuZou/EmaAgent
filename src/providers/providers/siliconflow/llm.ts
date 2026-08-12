// 声明 SiliconFlow 文本推理线路和经过能力分类的模型目录来源。
import type { ProviderCapability } from '../../types.js';

export const siliconFlowLlm = {
  protocols: [{ protocol: 'openai-llm' }],
  catalog: { modelsDevId: 'siliconflow' },
} satisfies ProviderCapability<'openai-llm'>;
