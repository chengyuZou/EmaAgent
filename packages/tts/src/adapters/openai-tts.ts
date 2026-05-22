import type { TtsAdapter, TtsAdapterCall, TtsProviderConfig } from '../types.js';
import type { TtsStreamEvent, TtsErrorCode } from '@ema-agent/contracts';

// ── OpenAI-compatible /v1/audio/speech ──────────────────────────────────────
//
// Single request returns the full audio body. We stream the response body in
// reasonable chunks so the caller can start playback early; this is not true
// sentence-level streaming (OpenAI doesn't expose it), but the response starts
// arriving faster than waiting for the full body.
//
// Voice is always `catalog` for this protocol — clone kinds are rejected
// upstream by the service via the capability matrix.

const CHUNK_BYTES = 8 * 1024;

export class OpenAiTtsAdapter implements TtsAdapter {
  readonly protocol = 'openai-tts' as const;

  constructor(private readonly config: TtsProviderConfig) {}

  async *stream(call: TtsAdapterCall): AsyncIterable<TtsStreamEvent> {
    if (call.voice.kind !== 'catalog') {
      yield errorEvent('permanent_unsupported_voice_kind',
        'openai-tts adapter only accepts catalog voices');
      return;
    }

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/audio/speech`;
    const body = {
      model:           call.model,
      voice:           call.voice.voiceId,
      input:           call.text,
      response_format: call.format,
      speed:           call.speed ?? 1.0,
      stream:          true,
    };

    const startedAt = Date.now();
    let totalBytes  = 0;
    let firstByteMs = 0;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body:   JSON.stringify(body),
        signal: call.abortSignal,
      });
    } catch (err) {
      yield errorEvent(classifyFetchError(err), (err as Error).message);
      return;
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      yield errorEvent(classifyHttpStatus(response.status), `${response.status} ${text.slice(0, 200)}`);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield errorEvent('unknown', 'response has no body');
      return;
    }

    const mime = response.headers.get('content-type') ?? mimeForFormat(call.format);

    try {
      let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        if (firstByteMs === 0) firstByteMs = Date.now() - startedAt;
        totalBytes += value.length;

        // Re-chunk to ~8KB so SSE frames stay reasonable
        pending = concat(pending, value);
        while (pending.length >= CHUNK_BYTES) {
          yield { type: 'audio_chunk', bytes: pending.slice(0, CHUNK_BYTES), mime };
          pending = pending.slice(CHUNK_BYTES);
        }
      }
      if (pending.length > 0) {
        yield { type: 'audio_chunk', bytes: pending, mime };
      }
    } catch (err) {
      yield errorEvent(classifyFetchError(err), (err as Error).message);
      return;
    }

    yield { type: 'done', totalBytes, firstByteMs };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function errorEvent(code: TtsErrorCode, message: string): TtsStreamEvent {
  return { type: 'error', code, message };
}

function classifyFetchError(err: unknown): TtsErrorCode {
  const name = (err as { name?: string }).name;
  if (name === 'AbortError') return 'transient_timeout';
  return 'transient_network';
}

function classifyHttpStatus(status: number): TtsErrorCode {
  if (status === 401 || status === 403) return 'permanent_credentials';
  if (status === 400 || status === 422) return 'permanent_bad_request';
  if (status === 404)                   return 'permanent_unsupported_model';
  if (status === 408 || status === 429) return 'transient_timeout';
  if (status >= 500)                    return 'transient_server';
  return 'unknown';
}

function mimeForFormat(format: string): string {
  switch (format) {
    case 'mp3':  return 'audio/mpeg';
    case 'wav':  return 'audio/wav';
    case 'opus': return 'audio/opus';
    case 'pcm':  return 'audio/L16';
    default:     return 'application/octet-stream';
  }
}

async function safeReadText(response: Response): Promise<string> {
  try { return await response.text(); } catch { return ''; }
}

function concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
