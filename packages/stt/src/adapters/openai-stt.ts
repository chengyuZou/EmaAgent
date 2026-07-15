import type { SttAdapter, SttAdapterCall, SttProviderConfig, SttProbeResult, SttResponse } from '../types.js';
import { SttError } from '../errors.js';

// ── OpenAI 兼容 /v1/audio/transcriptions(Whisper)────────────────────────
//
// Body 是 multipart/form-data:
//   - file:           音频字节(Whisper 接受的任意格式)
//   - model:          whisper-1 / gpt-4o-transcribe / FunAudioLLM/SenseVoiceSmall
//   - language:       可选 ISO 639-1(en / zh / ...)
//   - response_format:'verbose_json' 以拿分段时间戳
//
// 返回 { text: "..." }(json)或完整分段列表(verbose_json)。

export class OpenAiSttAdapter implements SttAdapter {
  readonly protocol = 'openai-stt' as const;

  constructor(private readonly config: SttProviderConfig) {}

  /**
   * 通过 GET /v1/models 实时探测 - 轻量鉴权检查,所有 OpenAI 兼容
   * provider 都适用,无需上传音频。provider 返任意 2xx 即 ok=true。
   */
  async probe(): Promise<Omit<SttProbeResult, 'providerId'>> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/models`;
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      const latencyMs = Date.now() - startedAt;
      if (res.ok) return { ok: true, latencyMs };
      const text = await safeReadText(res);
      return {
        ok:        false,
        latencyMs,
        error:     `HTTP ${res.status}: ${text.slice(0, 120)}`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async transcribe(call: SttAdapterCall): Promise<SttResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/audio/transcriptions`;

    const form = new FormData();
    form.append('file', new Blob([toArrayBuffer(call.audio)], { type: call.mime }), filenameFor(call.mime));
    form.append('model', call.model);
    form.append('response_format', 'verbose_json');
    if (call.language) form.append('language', call.language);

    const response = await fetch(url, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
      body:    form,
      signal:  call.abortSignal,
    });

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new SttError(
        'provider_failed',
        `STT provider returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        { status: response.status, retryable: response.status === 429 || response.status >= 500 },
      );
    }

    const body = await response.json() as {
      text: string;
      segments?: Array<{ start: number; end: number; text: string }>;
    };

    if (typeof body.text !== 'string') {
      throw new SttError('invalid_response', 'STT provider response is missing text');
    }

    return {
      text:     body.text,
      segments: body.segments?.map((s) => ({
        startMs: Math.round(s.start * 1000),
        endMs:   Math.round(s.end   * 1000),
        text:    s.text,
      })),
    };
  }
}

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  // 完整 ArrayBuffer 可直接交给 Blob;仅偏移视图或 SharedArrayBuffer 才复制。
  if (
    u8.buffer instanceof ArrayBuffer
    && u8.byteOffset === 0
    && u8.byteLength === u8.buffer.byteLength
  ) {
    return u8.buffer;
  }
  return u8.slice().buffer;
}

function filenameFor(mime: string): string {
  if (mime.includes('mp3') || mime.includes('mpeg')) return 'audio.mp3';
  if (mime.includes('wav'))                          return 'audio.wav';
  if (mime.includes('ogg'))                          return 'audio.ogg';
  if (mime.includes('webm'))                         return 'audio.webm';
  if (mime.includes('m4a') || mime.includes('mp4'))  return 'audio.m4a';
  return 'audio.bin';
}

async function safeReadText(response: Response): Promise<string> {
  try { return await response.text(); } catch { return ''; }
}
