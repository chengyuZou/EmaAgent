import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'siliconflow',
  name: 'SiliconFlow',
  defaultBaseUrl: 'https://api.siliconflow.cn/v1',
  protocolBaseUrls: {
    'openai-llm':    'https://api.siliconflow.cn/v1',
    'openai-embed':  'https://api.siliconflow.cn/v1',
    'openai-vision': 'https://api.siliconflow.cn/v1',
    'cohere-rerank': 'https://api.siliconflow.cn/v1',
    'openai-tts':    'https://api.siliconflow.cn/v1',
    'openai-stt':    'https://api.siliconflow.cn/v1',
  },
  capabilities: ['llm', 'embed', 'rerank', 'vision', 'tts', 'stt'],
  protocols: {
    llm:    ['openai-llm'],
    embed:  ['openai-embed'],
    rerank: ['cohere-rerank'],
    vision: ['openai-vision'],
    tts:    ['openai-tts'],
    stt:    ['openai-stt'],
  },
  defaultModels: {
    llm:    ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    embed:  ['Pro/BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5'],
    rerank: ['BAAI/bge-reranker-v2-m3'],
    vision: ['Qwen/Qwen2-VL-72B-Instruct', 'Pro/Qwen/Qwen2.5-VL-7B-Instruct'],
    tts:    ['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5'],
    stt:    ['FunAudioLLM/SenseVoiceSmall'],
  },
  iconKey: 'i-lobe-icons:siliconcloud',
  iconColor: 'i-lobe-icons:siliconcloud-color',
});
