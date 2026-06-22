import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'anthropic',
  modelsDevId: 'anthropic',
  name: 'Anthropic',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  protocolBaseUrls: { 'anthropic-llm': 'https://api.anthropic.com/v1' },
  capabilities: ['llm'],
  protocols: { llm: ['anthropic-llm'] },
  iconKey: 'i-lobe-icons:claude',
  iconColor: 'i-lobe-icons:claude-color',
});
