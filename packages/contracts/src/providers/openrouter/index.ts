import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'openrouter',
  modelsDevId: 'openrouter',
  name: 'OpenRouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  protocolBaseUrls: { 'openai-llm': 'https://openrouter.ai/api/v1' },
  capabilities: ['llm'],
  protocols: { llm: ['openai-llm'] },
  defaultModels: { llm: ['openai/gpt-4o', 'anthropic/claude-sonnet-4-5', 'google/gemini-2.5-pro'] },
  iconKey: 'i-lobe-icons:openrouter',
  iconColor: 'i-lobe-icons:openrouter-color',
});
