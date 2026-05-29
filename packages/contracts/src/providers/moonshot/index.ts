import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'moonshot',
  name: 'Moonshot Kimi',
  defaultBaseUrl: 'https://api.moonshot.cn/v1',
  protocolBaseUrls: { 'openai-llm': 'https://api.moonshot.cn/v1' },
  capabilities: ['llm'],
  protocols: { llm: ['openai-llm'] },
  defaultModels: { llm: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  iconKey: 'i-lobe-icons:moonshot',
  iconColor: 'i-lobe-icons:moonshot-color',
});
