import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'anthropic',
  modelsDevId: 'anthropic',
  name: 'Anthropic',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  protocolBaseUrls: { 'anthropic-llm': 'https://api.anthropic.com/v1' },
  capabilities: ['llm'],
  protocols: { llm: ['anthropic-llm'] },
  defaultModels: {
    llm: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  },
  iconKey: 'i-lobe-icons:claude',
  iconColor: 'i-lobe-icons:claude-color',
});
