import { defineProvider } from '../types.js';

/**
 * Local GPT-SoVITS server. The user runs `api_v2.py` themselves; we just talk
 * to it. There is no catalog of "voices" — every synthesis must supply a
 * reference audio + prompt text (see CharacterRefAudio in tts.ts).
 *
 * `requiresCredentials: false` hides the API key field in settings.
 * `baseUrl` defaults to the GPT-SoVITS api_v2.py default port; user can
 * change this if they run on a different host/port.
 *
 * `model` in DashScope-/OpenAI-land identifies the voice; for GPT-SoVITS the
 * concept of "model" is the SoVITS/GPT weight pair the server was launched
 * with — the client cannot switch it per-request, so model_bindings.model is
 * informational only (label like "default-v2"). The actual identity comes
 * from the reference audio.
 */
export const provider = defineProvider({
  id: 'gpt-sovits',
  name: 'GPT-SoVITS (本地)',
  defaultBaseUrl: 'http://127.0.0.1:9880',
  protocolBaseUrls: { 'gpt-sovits-tts': 'http://127.0.0.1:9880' },
  capabilities: ['tts'],
  protocols: { tts: ['gpt-sovits-tts'] },
  requiresCredentials: false,
  defaultModels: {
    tts: ['default'],
  },
  iconKey: 'i-lobe-icons:huggingface',
  iconColor: 'i-lobe-icons:huggingface-color',
});
