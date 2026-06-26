import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'xai',
  modelsDevId: 'xai',
  name: 'xAI Grok',
  defaultBaseUrl: 'https://api.x.ai/v1',
  protocolBaseUrls: { 'openai-llm': 'https://api.x.ai/v1' },
  capabilities: ['llm', 'vision'],
  protocols: { llm: ['openai-llm'], vision: ['openai-vision'] },
  iconKey: 'i-lobe-icons:xai',
  iconColor: 'i-lobe-icons:xai-color',
});
