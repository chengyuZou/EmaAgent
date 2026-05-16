import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'openai',
  name: 'OpenAI',
  defaultBaseUrl: 'https://api.openai.com/v1',
  capabilities: ['llm', 'embed'],
  protocols: { llm: 'openai-llm', embed: 'openai-embed' },
  defaultModels: {
    llm:   ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    embed: ['text-embedding-3-small', 'text-embedding-3-large'],
  },
  iconKey: 'i-lobe-icons:openai',
});
