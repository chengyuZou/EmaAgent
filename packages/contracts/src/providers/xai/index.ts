import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'xai',
  name: 'xAI Grok',
  defaultBaseUrl: 'https://api.x.ai/v1',
  protocolBaseUrls: { 'openai-llm': 'https://api.x.ai/v1' },
  capabilities: ['llm'],
  protocols: { llm: ['openai-llm'] },
  defaultModels: { llm: ['grok-4', 'grok-4-mini'] },
  iconKey: 'i-lobe-icons:xai',
  iconColor: 'i-lobe-icons:xai-color',
});
