import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'siliconflow',
  name: 'SiliconFlow',
  defaultBaseUrl: 'https://api.siliconflow.cn/v1',
  capabilities: ['llm', 'embed', 'rerank', 'tts', 'stt'],
  protocols: {
    llm:    'openai-llm',
    embed:  'openai-embed',
    rerank: 'cohere-rerank',
    tts:    'openai-tts',
    stt:    'openai-stt',
  },
  defaultModels: {
    llm:    ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    embed:  ['Pro/BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5'],
    rerank: ['BAAI/bge-reranker-v2-m3'],
    tts:    ['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5'],
    stt:    ['FunAudioLLM/SenseVoiceSmall'],
  },
  iconKey: 'i-lobe-icons:siliconcloud',
  iconColor: 'i-lobe-icons:siliconcloud-color',
});
