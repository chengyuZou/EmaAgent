/**
 * Transcribe API — speech-to-text via multipart upload.
 * Types imported from @ema-agent/stt.
 */
import { sidecarClient } from './sidecar-client.js';
import type { SttResponse, SttSegment } from '@ema-agent/stt';

export type { SttResponse, SttSegment };

// ── API object ────────────────────────────────────────────────────────────────

export const transcribeApi = {
  /** POST /api/transcribe — upload audio blob for STT. */
  async transcribe(input: {
    audio: Blob;
    mime: string;
    language?: string;
  }): Promise<SttResponse> {
    const form = new FormData();
    form.set('file', input.audio, `recording.${input.mime.split('/')[1] ?? 'webm'}`);
    if (input.language) form.set('language', input.language);

    return sidecarClient.request<SttResponse>('/api/transcribe', {
      method: 'POST',
      body: form,
    });
  },
};
