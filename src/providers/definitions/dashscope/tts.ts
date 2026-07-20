// 声明 DashScope TTS 的共享业务线路；模型族的 WS 细分由 TTS Adapter 负责。
import { defineTtsCapability } from '../../types.js';

export const dashScopeTts = defineTtsCapability({
  transports: [{ protocol: 'dashscope-tts' }],
  models: {
    sources: [
      {
        type: 'static',
        models: [
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
      { type: 'manual' },
    ],
  },
});
