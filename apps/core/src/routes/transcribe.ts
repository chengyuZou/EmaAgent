import { Hono } from 'hono';
import type { AppBindings } from '../wiring.js';

// ── POST /api/transcribe ────────────────────────────────────────────────────
//
// Multipart upload: `file` field (audio bytes), optional `language` field.
// Returns `{ text, segments? }` where segments may be absent if the provider
// doesn't support timestamps.
//
// No streaming, no auth on top of the sidecar's existing X-Ema-Secret —
// transcription is one-shot, sub-30-second audio typically.

export function transcribeRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    if (!bindings.stt.isAvailable()) {
      return c.json({ error: 'stt_not_configured' }, 503);
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'invalid_multipart' }, 400);
    }

    const file = form.get('file');
    if (!(file instanceof File) && !(file instanceof Blob)) {
      return c.json({ error: 'missing_file_field' }, 400);
    }

    const language = typeof form.get('language') === 'string'
      ? (form.get('language') as string)
      : undefined;

    const buf = new Uint8Array(await file.arrayBuffer());
    const mime = file.type || 'audio/webm';

    try {
      const result = await bindings.stt.transcribe({ audio: buf, mime, language });
      return c.json(result);
    } catch (err) {
      const message = (err as Error).message;
      return c.json({ error: 'stt_failed', message }, 502);
    }
  });

  return app;
}
