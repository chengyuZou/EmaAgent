import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'fireworks',
  name: 'Fireworks AI',
  defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
  protocolBaseUrls: { 'openai-llm': 'https://api.fireworks.ai/inference/v1' },
  capabilities: ['llm'],
  protocols: { llm: ['openai-llm'] },
  defaultModels: { llm: ['accounts/fireworks/models/llama-v4-maverick-17b-128e', 'accounts/fireworks/models/deepseek-v3'] },
  iconKey: 'i-lobe-icons:fireworks',
  iconColor: 'i-lobe-icons:fireworks-color',
});
