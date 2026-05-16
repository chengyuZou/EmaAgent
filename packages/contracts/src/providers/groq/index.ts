import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'groq',
  name: 'Groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  capabilities: ['llm'],
  protocols: { llm: 'openai-llm' },
  iconKey: 'i-lobe-icons:groq',
});
