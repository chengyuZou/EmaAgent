import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'ollama',
  name: 'Ollama',
  defaultBaseUrl: 'http://localhost:11434/v1',
  capabilities: ['llm', 'embed'],
  protocols: { llm: 'openai-llm', embed: 'openai-embed' },
  requiresCredentials: false,
  iconKey: 'i-lobe-icons:ollama',
});
