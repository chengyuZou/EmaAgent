import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'fireworks',
  modelsDevId: 'fireworks-ai',
  name: 'Fireworks AI',
  defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
  protocolBaseUrls: { 'openai-llm': 'https://api.fireworks.ai/inference/v1' },
  capabilities: ['llm', 'vision'],
  protocols: { llm: ['openai-llm'], vision: ['openai-vision'] },
  iconKey: 'i-lobe-icons:fireworks',
  iconColor: 'i-lobe-icons:fireworks-color',
});
