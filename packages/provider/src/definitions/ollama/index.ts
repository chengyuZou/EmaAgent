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
      models: { sources: [{ type: 'live' }, { type: 'manual' }] },
    },
    embed: {
      transports: [{ protocol: 'openai-embed' }],
      models: {
        sources: [
          { type: 'static', models: ['nomic-embed-text', 'mxbai-embed-large'] },
          { type: 'live' },
          { type: 'manual' },
        ],
      },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: {
        sources: [
          { type: 'static', models: ['llava', 'llava-llama3', 'moondream'] },
          { type: 'live' },
          { type: 'manual' },
        ],
      },
    },
  },
});
