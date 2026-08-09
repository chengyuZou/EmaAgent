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
      models: { modelsDevId: 'zhipuai' },
    },
    embed: {
      transports: [{ protocol: 'openai-embed' }],
      models: { staticModels: ['embedding-3'] },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: { modelsDevId: 'zhipuai' },
    },
  },
});
