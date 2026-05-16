import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'lmstudio',
  name: 'LM Studio',
  defaultBaseUrl: 'http://localhost:1234/v1',
  capabilities: ['llm', 'embed'],
  protocols: { llm: 'openai-llm', embed: 'openai-embed' },
  requiresCredentials: false,
  iconKey: 'i-lobe-icons:lmstudio',
});
