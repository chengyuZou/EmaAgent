import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'openai',
  modelsDevId: 'openai',
  name: 'OpenAI',
  defaultBaseUrl: 'https://api.openai.com/v1',
  protocolBaseUrls: {
    'openai-llm':            'https://api.openai.com/v1',
    'openai-responses-llm':  'https://api.openai.com/v1',
    'openai-embed':          'https://api.openai.com/v1',
    'openai-vision':         'https://api.openai.com/v1',
    'openai-tts':            'https://api.openai.com/v1',
    'openai-stt':            'https://api.openai.com/v1',
  },
  capabilities: ['llm', 'embed', 'vision', 'tts', 'stt'],
  protocols: {
    // openai-llm      = Chat Completions — broad OpenAI-compat support
    // openai-responses-llm = Responses API  — per-tool done events, o-series reasoning
    embed: ['openai-embed'],
    vision: ['openai-vision'],
    tts:   ['openai-tts'],
    stt:   ['openai-stt'],
  },
  defaultModels: {
    embed: ['text-embedding-3-small', 'text-embedding-3-large'],
    vision: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
    tts:   ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    stt:   ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
  },
  iconKey: 'i-lobe-icons:openai',
  iconColor: 'i-lobe-icons:openai-color',
});
