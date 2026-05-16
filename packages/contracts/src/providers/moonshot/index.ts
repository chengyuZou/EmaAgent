import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'moonshot',
  name: 'Moonshot Kimi',
  defaultBaseUrl: 'https://api.moonshot.cn/v1',
  capabilities: ['llm'],
  protocols: { llm: 'openai-llm' },
  iconKey: 'i-lobe-icons:moonshot',
});
