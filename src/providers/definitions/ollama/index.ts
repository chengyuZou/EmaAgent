import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'ollama',
  name: 'Ollama',
  branding: { iconId: 'ollama' },
  connection: {
    defaultBaseUrl: 'http://localhost:11434/v1',
    auth: { type: 'none' },
  },
  capabilities: {
    llm: {
      transports: [{ protocol: 'openai-llm' }],
      models: { supportsLiveListing: true },
    },
    embed: {
      transports: [{ protocol: 'openai-embed' }],
      models: {
        staticModels: ['nomic-embed-text', 'mxbai-embed-large'],
        supportsLiveListing: true,
      },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: {
        staticModels: ['llava', 'llava-llama3', 'moondream'],
        supportsLiveListing: true,
      },
    },
  },
});
