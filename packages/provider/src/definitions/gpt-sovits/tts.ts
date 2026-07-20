// 声明本地 GPT-SoVITS 服务的固定模型标签和手动补充入口。
import { defineTtsCapability } from '../../types.js';

export const gptSovitsTts = defineTtsCapability({
  transports: [{ protocol: 'gpt-sovits-tts' }],
  models: {
    sources: [
      { type: 'static', models: ['default'] },
      { type: 'manual' },
    ],
  },
});
