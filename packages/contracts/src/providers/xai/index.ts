import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'xai',
  name: 'xAI Grok',
  defaultBaseUrl: 'https://api.x.ai/v1',
  capabilities: ['llm'],
  protocols: { llm: 'openai-llm' },
  iconKey: 'i-lobe-icons:xai',
});
