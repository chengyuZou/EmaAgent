import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'ollama',
  name: 'Ollama',
  defaultBaseUrl: 'http://localhost:11434/v1',
  protocolBaseUrls: {
    'openai-llm':   'http://localhost:11434/v1',
    'openai-embed': 'http://localhost:11434/v1',
  },
  capabilities: ['llm', 'embed'],
  protocols: { llm: ['openai-llm'], embed: ['openai-embed'] },
  defaultModels: {
    llm:   ['llama3.2', 'qwen3', 'deepseek-r1'],
    embed: ['nomic-embed-text', 'mxbai-embed-large'],
  },
  requiresCredentials: false,
  iconKey: 'i-lobe-icons:ollama',
  iconColor: 'i-lobe-icons:ollama-color',
});
