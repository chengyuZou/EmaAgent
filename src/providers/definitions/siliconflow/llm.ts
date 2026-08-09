// 声明 SiliconFlow 文本推理线路和经过能力分类的模型目录来源。
import type { ProviderCapabilityDefinition } from '../../types.js';

export const siliconFlowLlm = {
  transports: [{ protocol: 'openai-llm' }],
  models: { modelsDevId: 'siliconflow' },
} satisfies ProviderCapabilityDefinition<'openai-llm'>;
