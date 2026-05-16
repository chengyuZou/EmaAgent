import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'mistral',
  name: 'Mistral',
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  capabilities: ['llm'],
  protocols: { llm: 'openai-llm' },
  iconKey: 'i-lobe-icons:mistral',
  iconColor: 'i-lobe-icons:mistral-color',
});
