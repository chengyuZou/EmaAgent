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
      protocols: [{ protocol: 'openai-llm' }],
      catalog: { supportsLiveListing: true },
    },
    embed: {
      protocols: [{ protocol: 'openai-embed' }],
      catalog: { staticModels: ['auto'], supportsLiveListing: true },
    },
  },
});
