import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'siliconflow',
  name: 'SiliconFlow',
  defaultBaseUrl: 'https://api.siliconflow.cn/v1',
  capabilities: ['llm', 'embed', 'rerank'],
  protocols: {
    llm:    'openai-llm',
    embed:  'openai-embed',
    rerank: 'cohere-rerank',
  },
  defaultModels: {
    llm:    ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    embed:  ['Pro/BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5'],
    rerank: ['BAAI/bge-reranker-v2-m3'],
  },
  iconKey: 'i-lobe-icons:siliconcloud',
  iconColor: 'i-lobe-icons:siliconcloud-color',
});
