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
      transports: [{ protocol: 'openai-llm' }],
      models: { sources: [{ type: 'models-dev', providerId: 'moonshotai' }, { type: 'manual' }] },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: { sources: [{ type: 'models-dev', providerId: 'moonshotai' }, { type: 'manual' }] },
    },
  },
});
