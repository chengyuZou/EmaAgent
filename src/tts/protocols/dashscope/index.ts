// 在 DashScope 协议族内部按模型选择 CosyVoice 或 Qwen TTS；无法识别的模型在创建点即失败。
import { TtsError } from '../../errors.js';
import type {
  TtsConnection,
  TtsProtocolImplementation,
} from '../../types.js';
import { synthesizeCosyVoice } from './cosyVoice.js';
import { synthesizeQwenTts } from './qwenTts.js';
import { enrollDashscopeVoice } from './voiceEnrollment.js';

type DashscopeTtsFamily = 'cosyvoice' | 'qwen-tts';

export function createDashscopeTtsProtocol(
  connection: TtsConnection,
  modelId: string,
): TtsProtocolImplementation {
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
        : synthesizeQwenTts(webSocketBaseUrl, apiKey, modelId, request);
    },
  };
}

function dashscopeFamily(modelId: string): DashscopeTtsFamily {
  if (modelId.startsWith('cosyvoice')) return 'cosyvoice';
  if (modelId.startsWith('qwen') && modelId.includes('tts')) return 'qwen-tts';
  throw new TtsError(
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
