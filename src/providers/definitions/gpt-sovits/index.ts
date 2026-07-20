import { defineProvider } from '../../types.js';
import { gptSovitsTts } from './tts.js';

export const provider = defineProvider({
  id: 'gpt-sovits',
  name: 'GPT-SoVITS (本地)',
  branding: { iconId: 'gpt-sovits' },
  connection: {
    defaultBaseUrl: 'http://127.0.0.1:9880',
    auth: { type: 'none' },
  },
  capabilities: { tts: gptSovitsTts },
});
