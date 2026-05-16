import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'together',
  name: 'Together AI',
  defaultBaseUrl: 'https://api.together.xyz/v1',
  capabilities: ['llm', 'embed'],
  protocols: { llm: 'openai-llm', embed: 'openai-embed' },
  iconKey: 'i-lobe-icons:together',
  iconColor: 'i-lobe-icons:together-color',
});
