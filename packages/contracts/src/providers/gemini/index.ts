import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'gemini',
  modelsDevId: 'google',
  name: 'Google Gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  protocolBaseUrls: { 'gemini-llm': 'https://generativelanguage.googleapis.com' },
  capabilities: ['llm', 'vision'],
  protocols: { llm: ['gemini-llm'], vision: ['gemini-vision'] },
  iconKey: 'i-lobe-icons:gemini',
  iconColor: 'i-lobe-icons:gemini-color',
});
