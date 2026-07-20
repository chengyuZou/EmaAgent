import { defineProvider } from '../../types.js';
import { openAiEmbedding } from './embedding.js';
import { openAiLlm } from './llm.js';
import { openAiStt } from './stt.js';
import { openAiTts } from './tts.js';
import { openAiVision } from './vision.js';

export const provider = defineProvider({
  id: 'openai',
  name: 'OpenAI',
  branding: { iconId: 'openai' },
  connection: {
    defaultBaseUrl: 'https://api.openai.com/v1',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: openAiLlm,
    embed: openAiEmbedding,
    vision: openAiVision,
    tts: openAiTts,
    stt: openAiStt,
  },
});
