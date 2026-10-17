import { TTSError } from '../../errors.js';
import type {
  TTSConnection,
  TTSProtocolImplementation,
} from '../../types.js';
import { synthesizeCosyVoice } from './cosyVoice.js';
import { synthesizeQwenTTS } from './qwenTTS.js';
import { enrollDashscopeVoice } from './voiceEnrollment.js';

type DashscopeTTSFamily = 'cosyvoice' | 'qwen-tts';

export function createDashscopeTTSProtocol(
  connection: TTSConnection,
  modelId: string,
): TTSProtocolImplementation {
  // 两个模型族的 WebSocket 消息不同, 在创建时选好, 合成过程中不再切换.
  const family = dashscopeFamily(modelId);
  const baseUrl = connection.baseUrl ?? 'https://dashscope.aliyuncs.com';
  const httpBaseUrl = toHttpBaseUrl(baseUrl);
  const webSocketBaseUrl = toWebSocketBaseUrl(baseUrl);
  const apiKey = connection.apiKey ?? '';

  return {
    prepareVoice(reference, signal) {
      return enrollDashscopeVoice(
        httpBaseUrl,
        apiKey,
        family,
        reference,
        modelId,
        signal,
      );
    },
    synthesize(request) {
      return family === 'cosyvoice'
        ? synthesizeCosyVoice(webSocketBaseUrl, apiKey, modelId, request)
        : synthesizeQwenTTS(webSocketBaseUrl, apiKey, modelId, request);
    },
  };
}

function dashscopeFamily(modelId: string): DashscopeTTSFamily {
  if (modelId.startsWith('cosyvoice')) return 'cosyvoice';
  if (modelId.startsWith('qwen') && modelId.includes('tts')) return 'qwen-tts';
  throw new TTSError(
    'tts/unsupported_model',
    `DashScope does not recognize TTS model "${modelId}"`,
  );
}

function toWebSocketBaseUrl(baseUrl: string): string {
  if (baseUrl.startsWith('wss://') || baseUrl.startsWith('ws://')) return baseUrl;
  if (baseUrl.startsWith('https://')) return `wss://${baseUrl.slice('https://'.length)}`;
  if (baseUrl.startsWith('http://')) return `ws://${baseUrl.slice('http://'.length)}`;
  return 'wss://dashscope.aliyuncs.com';
}

function toHttpBaseUrl(baseUrl: string): string {
  if (baseUrl.startsWith('https://') || baseUrl.startsWith('http://')) return baseUrl;
  if (baseUrl.startsWith('wss://')) return `https://${baseUrl.slice('wss://'.length)}`;
  if (baseUrl.startsWith('ws://')) return `http://${baseUrl.slice('ws://'.length)}`;
  return 'https://dashscope.aliyuncs.com';
}
