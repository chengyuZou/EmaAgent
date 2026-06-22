import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'openrouter',
  modelsDevId: 'openrouter',
  name: 'OpenRouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  protocolBaseUrls: { 'openai-llm': 'https://openrouter.ai/api/v1' },
  capabilities: ['llm'],
  protocols: { llm: ['openai-llm'] },
  iconKey: 'i-lobe-icons:openrouter',
  iconColor: 'i-lobe-icons:openrouter-color',
});
