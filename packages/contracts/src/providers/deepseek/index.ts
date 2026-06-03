import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'deepseek',
  name: 'DeepSeek',
  // OpenAI-compatible endpoint is the primary base URL
  defaultBaseUrl: 'https://api.deepseek.com',
  // Anthropic-compatible endpoint uses a different path
  protocolBaseUrls: {
    'openai-llm':    'https://api.deepseek.com',
    'anthropic-llm': 'https://api.deepseek.com/anthropic',
  },
  capabilities: ['llm'],
  // User picks protocol when adding a config; openai-llm is the default (first)
  protocols: { llm: ['openai-llm', 'anthropic-llm'] },
  defaultModels: { llm: ['deepseek-chat', 'deepseek-reasoner'] },
  iconKey: 'i-lobe-icons:deepseek',
  iconColor: 'i-lobe-icons:deepseek-color',
});
