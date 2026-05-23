/**
 * Transcribe API — speech-to-text via multipart upload.
 */
import { sidecarClient } from './sidecar-client.js';

// ── Wire-format types ────────────────────────────────────────────────────────

export interface SttSegment {
  start: number;
  end:   number;
  text:  string;
}

export interface TranscribeResult {
  text:     string;
  segments?: SttSegment[];
}

// ── API object ────────────────────────────────────────────────────────────────

export const transcribeApi = {
  /** POST /api/transcribe — upload audio blob for STT. */
  async transcribe(input: {
    audio: Blob;
    mime: string;
    language?: string;
  }): Promise<TranscribeResult> {
    const form = new FormData();
    form.set('file', input.audio, `recording.${input.mime.split('/')[1] ?? 'webm'}`);
    if (input.language) form.set('language', input.language);

    return sidecarClient.request<TranscribeResult>('/api/transcribe', {
      method: 'POST',
      body: form,
    });
  },
};
