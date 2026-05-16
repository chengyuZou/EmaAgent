import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'deepseek',
  name: 'DeepSeek',
  defaultBaseUrl: 'https://api.deepseek.com',
  capabilities: ['llm'],
  protocols: { llm: 'openai-llm' },
  defaultModels: { llm: ['deepseek-chat', 'deepseek-reasoner'] },
  iconKey: 'i-lobe-icons:deepseek',
  iconColor: 'i-lobe-icons:deepseek-color',
});
