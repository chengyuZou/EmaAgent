import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'zhipu',
  name: '智谱 GLM',
  defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  capabilities: ['llm', 'embed'],
  protocols: { llm: 'openai-llm', embed: 'openai-embed' },
  iconKey: 'i-lobe-icons:zhipu',
  iconColor: 'i-lobe-icons:zhipu-color',
});
