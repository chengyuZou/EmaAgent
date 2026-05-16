import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'openrouter',
  name: 'OpenRouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  capabilities: ['llm'],
  protocols: { llm: 'openai-llm' },
  iconKey: 'i-lobe-icons:openrouter',
});
