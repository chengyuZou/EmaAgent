import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'gemini',
  modelsDevId: 'google',
  name: 'Google Gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  protocolBaseUrls: { 'gemini-llm': 'https://generativelanguage.googleapis.com' },
  capabilities: ['llm'],
  protocols: { llm: ['gemini-llm'] },
  defaultModels: {
    llm: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  iconKey: 'i-lobe-icons:gemini',
  iconColor: 'i-lobe-icons:gemini-color',
});
