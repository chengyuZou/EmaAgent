// 在 DashScope 协议族内部按模型选择 CosyVoice 或 Qwen TTS。
import { TtsError } from '../../errors.js';
import type {
  TtsConnection,
  TtsProtocolImplementation,
  TtsRequest,
} from '../../types.js';
import { synthesizeCosyVoice } from './cosyVoice.js';
import { synthesizeQwenTts } from './qwenTts.js';
import { enrollDashscopeVoice } from './voiceEnrollment.js';

type DashscopeTtsFamily = 'cosyvoice' | 'qwen-tts';

export function createDashscopeTtsProtocol(
  connection: TtsConnection,
): TtsProtocolImplementation {
  const baseUrl = connection.baseUrl ?? 'https://dashscope.aliyuncs.com';
  const httpBaseUrl = toHttpBaseUrl(baseUrl);
  const webSocketBaseUrl = toWebSocketBaseUrl(baseUrl);
  const apiKey = connection.apiKey ?? '';

  return {
    prepareVoice(reference, model, signal) {
      return enrollDashscopeVoice(
        httpBaseUrl,
        apiKey,
        dashscopeFamily(model),
        reference,
        model,
        signal,
      );
    },
    synthesize(request) {
      return synthesizeDashscope(webSocketBaseUrl, apiKey, request);
    },
  };
}

function synthesizeDashscope(
  webSocketBaseUrl: string,
  apiKey: string,
  request: TtsRequest,
) {
  return dashscopeFamily(request.model) === 'cosyvoice'
    ? synthesizeCosyVoice(webSocketBaseUrl, apiKey, request)
    : synthesizeQwenTts(webSocketBaseUrl, apiKey, request);
}

function dashscopeFamily(model: string): DashscopeTtsFamily {
  if (model.startsWith('cosyvoice')) return 'cosyvoice';
  if (model.startsWith('qwen') && model.includes('tts')) return 'qwen-tts';
  throw new TtsError(
    'tts/unsupported_model',
    `DashScope does not recognize TTS model "${model}"`,
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
