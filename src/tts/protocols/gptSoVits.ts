// 执行 GPT-SoVITS 本地协议，并直接使用角色参考音频路径。
import { TtsError, ttsErrorFromHttp, ttsErrorFromNetwork } from '../errors.js';
import type {
  TtsConnection,
  TtsProtocolImplementation,
  TtsRequest,
  TtsStreamEvent,
} from '../types.js';
import { concatBytes, safeReadText } from '../utils.js';

const CHUNK_BYTES = 8 * 1024;

export function createGptSoVitsTtsProtocol(
  connection: TtsConnection,
): TtsProtocolImplementation {
  const baseUrl = (connection.baseUrl ?? 'http://127.0.0.1:9880').replace(/\/$/, '');
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
  const outputFormat = mapFormat(request.format ?? 'mp3');
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
        media_type: outputFormat,
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
  const reader = response.body?.getReader();
  if (!reader) throw new TtsError('tts/invalid_response', 'GPT-SoVITS response has no body');

  const startedAt = Date.now();
  const mime = response.headers.get('content-type') ?? mimeForOutput(outputFormat);
  let firstByteMs = 0;
  let totalBytes = 0;
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (firstByteMs === 0) firstByteMs = Date.now() - startedAt;
      totalBytes += value.byteLength;
      pending = concatBytes(pending, value);
      while (pending.byteLength >= CHUNK_BYTES) {
        yield { type: 'audio_chunk', bytes: pending.slice(0, CHUNK_BYTES), mime };
        pending = pending.slice(CHUNK_BYTES);
      }
    }
  } catch (error) {
    throw ttsErrorFromNetwork(error, request.signal);
  }
  if (pending.byteLength > 0) yield { type: 'audio_chunk', bytes: pending, mime };
  yield { type: 'done', totalBytes, firstByteMs };
}

function looksLikeMissingReference(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes('ref_audio_path') && (lower.includes('not exist') || lower.includes('not found'));
}

function mapFormat(format: string): 'wav' | 'raw' | 'ogg' | 'aac' {
  if (format === 'mp3') return 'aac';
  if (format === 'opus') return 'ogg';
  if (format === 'pcm') return 'raw';
  return 'wav';
}

function mimeForOutput(format: string): string {
  if (format === 'aac') return 'audio/aac';
  if (format === 'ogg') return 'audio/ogg';
  if (format === 'raw') return 'audio/L16';
  return 'audio/wav';
}

function detectLanguage(text: string, fallback: string): string {
  const cjk = (text.match(/[一-鿿぀-ヿ]/g) ?? []).length;
  const ascii = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjk > ascii) return 'zh';
  if (ascii > cjk * 2) return 'en';
  return fallback;
}
