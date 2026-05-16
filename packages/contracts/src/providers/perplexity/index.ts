import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'perplexity',
  name: 'Perplexity',
  defaultBaseUrl: 'https://api.perplexity.ai',
  capabilities: ['llm'],
  protocols: { llm: 'openai-llm' },
  iconKey: 'i-lobe-icons:perplexity',
  iconColor: 'i-lobe-icons:perplexity-color',
});
