import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'zhipu',
  name: '智谱 GLM',
  branding: { iconId: 'zhipu' },
  connection: {
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: {
      transports: [{ protocol: 'openai-llm' }],
      models: { sources: [{ type: 'models-dev', providerId: 'zhipuai' }, { type: 'manual' }] },
    },
    embed: {
      transports: [{ protocol: 'openai-embed' }],
      models: { sources: [{ type: 'static', models: ['embedding-3'] }, { type: 'manual' }] },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: { sources: [{ type: 'models-dev', providerId: 'zhipuai' }, { type: 'manual' }] },
    },
  },
});
