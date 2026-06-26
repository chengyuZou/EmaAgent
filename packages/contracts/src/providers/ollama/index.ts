import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'ollama',
  name: 'Ollama',
  defaultBaseUrl: 'http://localhost:11434/v1',
  protocolBaseUrls: {
    'openai-llm':   'http://localhost:11434/v1',
    'openai-embed': 'http://localhost:11434/v1',
  },
  capabilities: ['llm', 'embed', 'vision'],
  protocols: { llm: ['openai-llm'], embed: ['openai-embed'], vision: ['openai-vision'] },
  defaultModels: {
    embed:  ['nomic-embed-text', 'mxbai-embed-large'],
    vision: ['llava', 'llava-llama3', 'moondream'],
  },
  requiresCredentials: false,
  iconKey: 'i-lobe-icons:ollama',
  iconColor: 'i-lobe-icons:ollama-color',
});
