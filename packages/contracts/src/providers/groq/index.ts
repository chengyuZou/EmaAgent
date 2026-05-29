import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'groq',
  name: 'Groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  protocolBaseUrls: { 'openai-llm': 'https://api.groq.com/openai/v1' },
  capabilities: ['llm'],
  protocols: { llm: ['openai-llm'] },
  defaultModels: { llm: ['llama-4-scout-17b-16e', 'llama-4-maverick-17b-128e', 'deepseek-r1-distill-llama-70b'] },
  iconKey: 'i-lobe-icons:groq',
  iconColor: 'i-lobe-icons:groq-color',
});
