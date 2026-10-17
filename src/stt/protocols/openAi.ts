import { STTError } from '../errors.js';
import type {
  STTConnection,
  TranscriptionRequest,
  TranscriptionResult,
} from '../types.js';

export function createOpenAiSTTProtocol(
  connection: STTConnection,
  modelId: string,
): (request: TranscriptionRequest) => Promise<TranscriptionResult> {
  const baseUrl = (connection.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');

  return async (request) => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([toArrayBuffer(request.audio)], { type: request.mimeType }),
      filenameFor(request.mimeType),
    );
    form.append('model', modelId);
    // 调用方只需要转写文本, 使用接口默认的 JSON 响应, 不强制要求时间分段.
    // 兼容此接口的模型不都接受 verbose_json, SiliconFlow 的 Qwen3-ASR 会因此返回 400.
    if (request.language?.trim()) form.append('language', request.language.trim());

    const headers: Record<string, string> = {};
    if (connection.apiKey) headers['Authorization'] = `Bearer ${connection.apiKey}`;
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
      signal: request.signal,
    });

    if (!response.ok) {
      const excerpt = (await response.text().catch(() => '')).slice(0, 500);
      throw new STTError(
        'stt/http_error',
        `openai-stt returned HTTP ${response.status}${excerpt ? `: ${excerpt}` : ''}`,
        response.status,
      );
    }

    const body = await readJson(response) as {
      text?: unknown;
      segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
    };
    if (typeof body.text !== 'string') {
      throw new STTError('stt/invalid_response', 'openai-stt response is missing text');
    }
    if (body.segments !== undefined && !Array.isArray(body.segments)) {
      throw new STTError('stt/invalid_response', 'openai-stt segments must be an array');
    }
    const segments = body.segments?.map((segment) => {
      if (
        typeof segment.start !== 'number'
        || typeof segment.end !== 'number'
        || typeof segment.text !== 'string'
      ) {
        throw new STTError('stt/invalid_response', 'openai-stt returned malformed segment');
      }
      return {
        startMs: Math.round(segment.start * 1_000),
        endMs: Math.round(segment.end * 1_000),
        text: segment.text,
      };
    });
    return {
      text: body.text,
      ...(segments ? { segments } : {}),
    };
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new STTError(
      'stt/invalid_response',
      'openai-stt returned invalid JSON',
      response.status,
      error,
    );
  }
}

function toArrayBuffer(audio: Uint8Array): ArrayBuffer {
  if (
    audio.buffer instanceof ArrayBuffer
    && audio.byteOffset === 0
    && audio.byteLength === audio.buffer.byteLength
  ) {
    return audio.buffer;
  }
  return audio.slice().buffer;
}

function filenameFor(mimeType: string): string {
  if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'audio.mp3';
  if (mimeType.includes('wav')) return 'audio.wav';
  if (mimeType.includes('ogg')) return 'audio.ogg';
  if (mimeType.includes('webm')) return 'audio.webm';
  if (mimeType.includes('m4a') || mimeType.includes('mp4')) return 'audio.m4a';
  return 'audio.bin';
}
