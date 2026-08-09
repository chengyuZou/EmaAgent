import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'lmstudio',
  name: 'LM Studio',
  branding: { iconId: 'lmstudio' },
  connection: {
    defaultBaseUrl: 'http://localhost:1234/v1',
    auth: { type: 'none' },
  },
  capabilities: {
    llm: {
      transports: [{ protocol: 'openai-llm' }],
      models: { supportsLiveListing: true },
    },
    embed: {
      transports: [{ protocol: 'openai-embed' }],
      models: { staticModels: ['auto'], supportsLiveListing: true },
    },
  },
});
