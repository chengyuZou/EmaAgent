import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'fireworks',
  name: 'Fireworks AI',
  defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
  capabilities: ['llm'],
  protocols: { llm: 'openai-llm' },
  iconKey: 'i-lobe-icons:fireworks',
  iconColor: 'i-lobe-icons:fireworks-color',
});
