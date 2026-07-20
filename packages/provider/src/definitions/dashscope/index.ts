import { defineProvider } from '../../types.js';
import { dashScopeTts } from './tts.js';

export const provider = defineProvider({
  id: 'dashscope',
  name: '阿里云百炼 (DashScope)',
  branding: { iconId: 'dashscope' },
  connection: {
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
    auth: { type: 'bearer', required: true },
  },
  capabilities: { tts: dashScopeTts },
});
