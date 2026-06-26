import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'openrouter',
  modelsDevId: 'openrouter',
  name: 'OpenRouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  protocolBaseUrls: { 'openai-llm': 'https://openrouter.ai/api/v1' },
  capabilities: ['llm', 'vision'],
  protocols: { llm: ['openai-llm'], vision: ['openai-vision'] },
  iconKey: 'i-lobe-icons:openrouter',
  iconColor: 'i-lobe-icons:openrouter-color',
});
