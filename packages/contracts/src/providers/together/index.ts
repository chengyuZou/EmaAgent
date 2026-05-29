import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'together',
  name: 'Together AI',
  defaultBaseUrl: 'https://api.together.xyz/v1',
  protocolBaseUrls: {
    'openai-llm':   'https://api.together.xyz/v1',
    'openai-embed': 'https://api.together.xyz/v1',
  },
  capabilities: ['llm', 'embed'],
  protocols: { llm: ['openai-llm'], embed: ['openai-embed'] },
  defaultModels: {
    llm:   ['meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', 'deepseek-ai/DeepSeek-V3'],
    embed: ['togethercomputer/m2-bert-80M-8k-retrieval'],
  },
  iconKey: 'i-lobe-icons:together',
  iconColor: 'i-lobe-icons:together-color',
});
