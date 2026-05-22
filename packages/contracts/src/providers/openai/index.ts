import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'openai',
  name: 'OpenAI',
  defaultBaseUrl: 'https://api.openai.com/v1',
  capabilities: ['llm', 'embed', 'tts', 'stt'],
  protocols: {
    llm:   'openai-llm',
    embed: 'openai-embed',
    tts:   'openai-tts',
    stt:   'openai-stt',
  },
  defaultModels: {
    llm:   ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    embed: ['text-embedding-3-small', 'text-embedding-3-large'],
    tts:   ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    stt:   ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
  },
  iconKey: 'i-lobe-icons:openai',
});
