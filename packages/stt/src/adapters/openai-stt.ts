import type { SttAdapter, SttAdapterCall, SttProviderConfig, SttProbeResult, SttResponse } from '../types.js';

// ── OpenAI-compatible /v1/audio/transcriptions (Whisper) ────────────────────
//
// Body is multipart/form-data:
//   - file:           the audio bytes (any format Whisper accepts)
//   - model:          whisper-1 / gpt-4o-transcribe / FunAudioLLM/SenseVoiceSmall
//   - language:       optional ISO 639-1 (en / zh / ...)
//   - response_format: 'verbose_json' to get segment timestamps
//
// Returns either { text: "..." } (json) or full segment list (verbose_json).

export class OpenAiSttAdapter implements SttAdapter {
  readonly protocol = 'openai-stt' as const;

  constructor(private readonly config: SttProviderConfig) {}

  /**
   * Live probe via GET /v1/models — a lightweight auth check that works on
   * all OpenAI-compatible providers without needing to upload audio.
   * Returns ok=true when the provider responds with any 2xx status.
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
      throw new Error(`stt/${response.status}: ${text.slice(0, 200)}`);
    }

    const body = await response.json() as {
      text: string;
      segments?: Array<{ start: number; end: number; text: string }>;
    };

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

// ── Helpers ─────────────────────────────────────────────────────────────────

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  // Detach from any SharedArrayBuffer / offset to keep Blob constructor happy
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
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
