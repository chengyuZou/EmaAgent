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
      models: { sources: [{ type: 'models-dev', providerId: 'togetherai' }, { type: 'manual' }] },
    },
    embed: {
      transports: [{ protocol: 'openai-embed' }],
      models: {
        sources: [
          { type: 'static', models: ['togethercomputer/m2-bert-80M-8k-retrieval'] },
          { type: 'manual' },
        ],
      },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: { sources: [{ type: 'models-dev', providerId: 'togetherai' }, { type: 'manual' }] },
    },
  },
});
