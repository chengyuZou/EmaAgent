// 声明本地 GPT-SoVITS 服务的固定模型标签和手动补充入口。
import type { ProviderCapabilityDefinition } from '../../types.js';

export const gptSovitsTts = {
  transports: [{ protocol: 'gpt-sovits-tts' }],
  models: { staticModels: ['default'] },
} satisfies ProviderCapabilityDefinition<'gpt-sovits-tts'>;
