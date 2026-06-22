import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'moonshot',
  modelsDevId: 'moonshotai',
  name: 'Moonshot Kimi',
  defaultBaseUrl: 'https://api.moonshot.cn/v1',
  protocolBaseUrls: { 'openai-llm': 'https://api.moonshot.cn/v1' },
  capabilities: ['llm'],
  protocols: { llm: ['openai-llm'] },
  iconKey: 'i-lobe-icons:moonshot',
  iconColor: 'i-lobe-icons:moonshot-color',
});
