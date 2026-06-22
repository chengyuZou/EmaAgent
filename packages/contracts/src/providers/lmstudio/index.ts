import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'lmstudio',
  modelsDevId: 'lmstudio',
  name: 'LM Studio',
  defaultBaseUrl: 'http://localhost:1234/v1',
  protocolBaseUrls: {
    'openai-llm':   'http://localhost:1234/v1',
    'openai-embed': 'http://localhost:1234/v1',
  },
  capabilities: ['llm', 'embed'],
  protocols: { llm: ['openai-llm'], embed: ['openai-embed'] },
  defaultModels: {
    embed: ['auto'],
  },
  requiresCredentials: false,
  iconKey: 'i-lobe-icons:lmstudio',
  iconColor: 'i-lobe-icons:lmstudio-color',
});
