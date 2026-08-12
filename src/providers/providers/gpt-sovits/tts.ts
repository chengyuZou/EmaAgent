// 声明本地 GPT-SoVITS 服务的固定模型标签和手动补充入口。
import type { ProviderCapability } from '../../types.js';

export const gptSovitsTts = {
  protocols: [{ protocol: 'gpt-sovits-tts' }],
  catalog: { staticModels: ['default'] },
} satisfies ProviderCapability<'gpt-sovits-tts'>;
