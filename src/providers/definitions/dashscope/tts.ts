// 声明 DashScope TTS 的共享业务线路；模型族的 WS 细分由 TTS Adapter 负责。
import type { ProviderCapabilityDefinition } from '../../types.js';

export const dashScopeTts = {
  transports: [{ protocol: 'dashscope-tts' }],
  models: {
    staticModels: [
      'cosyvoice-v3-flash',
      'cosyvoice-v3-plus',
      'cosyvoice-v3.5-flash',
      'cosyvoice-v3.5-plus',
      'cosyvoice-v2',
      'qwen3-tts-flash-realtime',
      'qwen3-tts-instruct-flash-realtime',
      'qwen-tts-realtime',
    ],
  },
} satisfies ProviderCapabilityDefinition<'dashscope-tts'>;
