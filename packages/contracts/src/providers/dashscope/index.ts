import { defineProvider } from '../types.js';

/**
 * 阿里云百炼 (DashScope). One provider, two TTS model families that share the
 * same Bearer auth and base host but use different WS paths/protocols:
 *
 *   - cosyvoice-*  → wss://.../api-ws/v1/inference/   (run-task / continue-task / finish-task)
 *   - qwen*-tts*   → wss://.../api-ws/v1/realtime    (session.update / input_text_buffer / response.audio.delta)
 *
 * The `dashscope-tts` adapter routes by model prefix internally; users see one
 * model dropdown that mixes both families (matches Aliyun's own console UI).
 *
 * V1 does not ship LLM/embed/STT for DashScope — only TTS. Aliyun Whisper-like
 * STT lives in 智能语音服务 (a different product) and is deferred to V1.5.
 */
export const provider = defineProvider({
  id: 'dashscope',
  name: '阿里云百炼 (DashScope)',
  defaultBaseUrl: 'https://dashscope.aliyuncs.com',
  protocolBaseUrls: { 'dashscope-tts': 'https://dashscope.aliyuncs.com' },
  capabilities: ['tts'],
  protocols: { tts: ['dashscope-tts'] },
  defaultModels: {
    tts: [
      // CosyVoice 系列
      'cosyvoice-v3-flash',
      'cosyvoice-v3-plus',
      'cosyvoice-v3.5-flash',
      'cosyvoice-v3.5-plus',
      'cosyvoice-v2',
      // Qwen-TTS 系列
      'qwen3-tts-flash-realtime',
      'qwen3-tts-instruct-flash-realtime',
      'qwen-tts-realtime',
    ],
  },
  iconKey: 'i-lobe-icons:alibabacloud',
  iconColor: 'i-lobe-icons:alibabacloud-color',
});
