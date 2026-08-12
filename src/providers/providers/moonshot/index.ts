import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'moonshot',
  name: 'Moonshot Kimi',
  branding: { iconId: 'moonshot' },
  connection: {
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: {
      protocols: [{ protocol: 'openai-llm' }],
      catalog: { modelsDevId: 'moonshotai' },
    },
    vision: {
      protocols: [{ protocol: 'openai-vision' }],
      catalog: { modelsDevId: 'moonshotai' },
    },
  },
});
