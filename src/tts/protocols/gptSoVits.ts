import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { TtsError, ttsErrorFromHttp, ttsErrorFromNetwork } from '../errors.js';
import type {
  TtsConnection,
  TtsProtocolImplementation,
  TtsRequest,
  TtsStreamEvent,
} from '../types.js';
import { safeReadText } from '../utils.js';
import { gptSoVitsWavEvents } from '../audio/wav.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:9880';

// GPT-SoVITS 使用服务已经加载的权重, /tts 请求中不传 modelId.
export function createGptSoVitsTtsProtocol(
  connection: TtsConnection,
  _modelId: string,
): TtsProtocolImplementation {
  const baseUrl = (connection.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  return {
    async prepareVoice(reference) {
      return reference;
    },
    synthesize(request) {
      return synthesizeGptSoVits(baseUrl, request);
    },
  };
}

async function* synthesizeGptSoVits(
  baseUrl: string,
  request: TtsRequest,
): AsyncGenerator<TtsStreamEvent> {
  if (request.voice.kind !== 'reference') {
    throw new TtsError('tts/unsupported_voice', 'GPT-SoVITS requires a local reference voice');
  }
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: request.text,
        text_lang: detectLanguage(request.text, request.voice.promptLanguage),
        ref_audio_path: request.voice.audioPath,
        prompt_text: request.voice.promptText,
        prompt_lang: request.voice.promptLanguage,
        // WAV 自带实际采样率, 不猜测不同 GPT-SoVITS 权重的裸 PCM 格式.
        media_type: 'wav',
        streaming_mode: true,
        speed_factor: request.speed ?? 1,
      }),
      signal: request.signal,
    });
  } catch (error) {
    throw ttsErrorFromNetwork(error, request.signal);
  }
  if (!response.ok) {
    const body = await safeReadText(response);
    if (looksLikeMissingReference(body)) {
      throw new TtsError('tts/reference_audio_missing', body);
    }
    throw ttsErrorFromHttp(response.status, body);
  }
  if (!response.body) {
    throw new TtsError('tts/invalid_response', 'GPT-SoVITS response has no body');
  }
  const input = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
  try {
    yield* gptSoVitsWavEvents(input, startedAt, request.signal);
  } catch (error) {
    if (error instanceof TtsError) {
      throw error;
    }
    throw ttsErrorFromNetwork(error, request.signal);
  } finally {
    input.destroy();
  }
}

function looksLikeMissingReference(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes('ref_audio_path') && (lower.includes('not exist') || lower.includes('not found'));
}

function detectLanguage(text: string, fallback: string): string {
  const cjk = (text.match(/[一-鿿぀-ヿ]/g) ?? []).length;
  const ascii = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjk > ascii) return 'zh';
  if (ascii > cjk * 2) return 'en';
  return fallback;
}
