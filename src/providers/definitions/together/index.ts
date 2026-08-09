import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'together',
  name: 'Together AI',
  branding: { iconId: 'together' },
  connection: {
    defaultBaseUrl: 'https://api.together.xyz/v1',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: {
      transports: [{ protocol: 'openai-llm' }],
      models: { modelsDevId: 'togetherai' },
    },
    embed: {
      transports: [{ protocol: 'openai-embed' }],
      models: { staticModels: ['togethercomputer/m2-bert-80M-8k-retrieval'] },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: { modelsDevId: 'togetherai' },
    },
  },
});
