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
      protocols: [{ protocol: 'openai-llm' }],
      catalog: { modelsDevId: 'togetherai' },
    },
    embed: {
      protocols: [{ protocol: 'openai-embed' }],
      catalog: { staticModels: ['togethercomputer/m2-bert-80M-8k-retrieval'] },
    },
    vision: {
      protocols: [{ protocol: 'openai-vision' }],
      catalog: { modelsDevId: 'togetherai' },
    },
  },
});
