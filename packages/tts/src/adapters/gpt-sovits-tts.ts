import type { TtsAdapter, TtsProviderConfig, TtsProbeResult, TtsRequest, TtsStreamEvent, TtsErrorCode } from '../types.js';

// ── GPT-SoVITS local server (api_v2.py) ─────────────────────────────────────
//
// POST {baseUrl}/tts  with JSON body:
//   {
//     text:                 "...",
//     text_lang:            "zh",          // text language
//     ref_audio_path:       "/path/to/ref.wav",
//     prompt_text:          "...",
//     prompt_lang:          "zh",
//     media_type:           "wav" | "raw" | "ogg" | "aac",
//     streaming_mode:       true,           // chunked response
//     ...other GPT-SoVITS knobs
//   }
//
// Response: chunked audio body, content-type matches media_type.
// On error, body is JSON: { "message": "..." }.
//
// V1 clone-only: voice carries refAudioPath, promptText, promptLang.
// `model` field is informational only (GPT-SoVITS doesn't switch weights
// per-request; users restart the server with different weights).

const CHUNK_BYTES = 8 * 1024;

export class GptSoVitsTtsAdapter implements TtsAdapter {
  readonly protocol = 'gpt-sovits-tts' as const;

  constructor(private readonly config: TtsProviderConfig) {}

  async *stream(req: TtsRequest): AsyncIterable<TtsStreamEvent> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/tts`;
    const mediaType = mapFormatToGptSovits(req.format ?? 'mp3');

    const body = {
      text:           req.text,
      text_lang:      detectLangHint(req.text, req.voice.promptLang),
      ref_audio_path: req.voice.refAudioPath,
      prompt_text:    req.voice.promptText,
      prompt_lang:    req.voice.promptLang,
      media_type:     mediaType,
      streaming_mode: true,
      speed_factor:   req.speed ?? 1.0,
    };

    const startedAt = Date.now();
    let totalBytes  = 0;
    let firstByteMs = 0;

    let response: Response;
    try {
      response = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  req.abortSignal,
      });
    } catch (err) {
      yield errorEvent(classifyFetchError(err), (err as Error).message);
      return;
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      // GPT-SoVITS returns 400 with { "message": "ref_audio_path not exists" }
      // when refAudio is missing — surface as permanent_refaudio_missing.
      const code = looksLikeMissingRef(text)
        ? 'permanent_refaudio_missing'
        : classifyHttpStatus(response.status);
      yield errorEvent(code, `${response.status} ${text.slice(0, 200)}`);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield errorEvent('unknown', 'response has no body');
      return;
    }

    const mime = response.headers.get('content-type') ?? mimeForFormat(req.format ?? 'mp3');

    try {
      let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        if (firstByteMs === 0) firstByteMs = Date.now() - startedAt;
        totalBytes += value.length;

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

  async probe(): Promise<TtsProbeResult> {
    const url = this.config.baseUrl.replace(/\/$/, '');
    const startedAt = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      const latencyMs = Date.now() - startedAt;
      // GPT-SoVITS server may return 404 on GET / but that still means it's up.
      return { ok: res.status < 500, latencyMs };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
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
  if (status === 400 || status === 422) return 'permanent_bad_request';
  if (status === 404)                   return 'permanent_unsupported_model';
  if (status === 408 || status === 429) return 'transient_timeout';
  if (status >= 500)                    return 'transient_server';
  return 'unknown';
}

function looksLikeMissingRef(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes('ref_audio_path') && (lower.includes('not exist') || lower.includes('not found'));
}

function mapFormatToGptSovits(format: string): string {
  // GPT-SoVITS api_v2 accepts: wav, raw, ogg, aac
  switch (format) {
    case 'mp3':  return 'aac';   // closest available
    case 'opus': return 'ogg';
    case 'pcm':  return 'raw';
    default:     return 'wav';
  }
}

function mimeForFormat(format: string): string {
  switch (format) {
    case 'mp3':  return 'audio/aac';
    case 'wav':  return 'audio/wav';
    case 'opus': return 'audio/ogg';
    case 'pcm':  return 'audio/L16';
    default:     return 'application/octet-stream';
  }
}

function detectLangHint(text: string, fallback: string): string {
  // Very rough heuristic — GPT-SoVITS accepts the prompt_lang for both, but
  // text_lang is what affects synthesis pronunciation. If the text is mostly
  // CJK, use 'zh'; if mostly ASCII letters, use 'en'; else fall back to the
  // prompt language.
  const cjk = (text.match(/[一-鿿぀-ヿ]/g) ?? []).length;
  const ascii = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjk > ascii) return 'zh';
  if (ascii > cjk * 2) return 'en';
  return fallback;
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
