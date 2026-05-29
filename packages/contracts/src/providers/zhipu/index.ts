import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'zhipu',
  name: '智谱 GLM',
  defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  protocolBaseUrls: {
    'openai-llm':   'https://open.bigmodel.cn/api/paas/v4',
    'openai-embed': 'https://open.bigmodel.cn/api/paas/v4',
  },
  capabilities: ['llm', 'embed'],
  protocols: { llm: ['openai-llm'], embed: ['openai-embed'] },
  defaultModels: {
    llm:   ['glm-4-plus', 'glm-4-flash', 'glm-4-air'],
    embed: ['embedding-3'],
  },
  iconKey: 'i-lobe-icons:zhipu',
  iconColor: 'i-lobe-icons:zhipu-color',
});
