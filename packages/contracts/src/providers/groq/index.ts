import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'groq',
  modelsDevId: 'groq',
  name: 'Groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  protocolBaseUrls: { 'openai-llm': 'https://api.groq.com/openai/v1' },
  capabilities: ['llm'],
  protocols: { llm: ['openai-llm'] },
  iconKey: 'i-lobe-icons:groq',
  iconColor: 'i-lobe-icons:groq-color',
});
