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
      protocols: [{ protocol: 'openai-llm' }],
      catalog: { supportsLiveListing: true },
    },
    embed: {
      protocols: [{ protocol: 'openai-embed' }],
      catalog: {
        staticModels: ['nomic-embed-text', 'mxbai-embed-large'],
        supportsLiveListing: true,
      },
    },
    vision: {
      protocols: [{ protocol: 'openai-vision' }],
      catalog: {
        staticModels: ['llava', 'llava-llama3', 'moondream'],
        supportsLiveListing: true,
      },
    },
  },
});
