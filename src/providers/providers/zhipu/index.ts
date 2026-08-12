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
      protocols: [{ protocol: 'openai-llm' }],
      catalog: { modelsDevId: 'zhipuai' },
    },
    embed: {
      protocols: [{ protocol: 'openai-embed' }],
      catalog: { staticModels: ['embedding-3'] },
    },
    vision: {
      protocols: [{ protocol: 'openai-vision' }],
      catalog: { modelsDevId: 'zhipuai' },
    },
  },
});
