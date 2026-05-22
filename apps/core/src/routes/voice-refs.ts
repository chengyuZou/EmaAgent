import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';

import type { AppBindings } from '../wiring.js';
import {
  asCharacterCardId,
  type CharacterRefAudio,
  type CharacterVoiceProfile,
} from '@ema-agent/contracts';
import { voiceRefsForCard, resolveVoiceRefPath } from '../storage-locations/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function getCardOr404(bindings: AppBindings, idStr: string) {
  const id = asCharacterCardId(idStr);
  const card = bindings.card.get(id);
  return card ? { id, card } : null;
}

function extForMime(mime: string): string {
  if (mime.includes('wav'))  return 'wav';
  if (mime.includes('mp3') || mime.includes('mpeg')) return 'mp3';
  if (mime.includes('flac')) return 'flac';
  if (mime.includes('ogg') || mime.includes('opus')) return 'ogg';
  if (mime.includes('m4a') || mime.includes('mp4'))  return 'm4a';
  return 'wav';
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case 'mp3':  return 'audio/mpeg';
    case 'wav':  return 'audio/wav';
    case 'flac': return 'audio/flac';
    case 'ogg':
    case 'opus': return 'audio/ogg';
    case 'm4a':  return 'audio/mp4';
    default:     return 'application/octet-stream';
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * Mounted at `/api/cards`. Endpoints:
 *   GET    /:cardId/voice-refs            list refs (no audio bytes)
 *   POST   /:cardId/voice-refs            multipart upload — adds a new ref
 *   GET    /:cardId/voice-refs/:refId     stream audio bytes
 *   DELETE /:cardId/voice-refs/:refId     remove ref entry + file
 *   PUT    /:cardId/voice-refs/primary    body: { refId } — switch primary
 *
 * Files live at `<profileDir>/voiceRefs/<cardId>/<refId>.<ext>` (profile-scope
 * so refAudio survives dataDir swaps). The card's voice_profile_json stores
 * the relative path `<cardId>/<refId>.<ext>`.
 */
export function voiceRefsRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // ── list ─────────────────────────────────────────────────────────────────
  app.get('/:cardId/voice-refs', (c) => {
    const found = getCardOr404(bindings, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);
    return c.json(found.card.voiceProfile);
  });

  // ── upload ───────────────────────────────────────────────────────────────
  app.post('/:cardId/voice-refs', async (c) => {
    const found = getCardOr404(bindings, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);

    let form: FormData;
    try { form = await c.req.formData(); }
    catch { return c.json({ error: 'invalid_multipart' }, 400); }

    const file = form.get('file');
    if (!(file instanceof File) && !(file instanceof Blob)) {
      return c.json({ error: 'missing_file_field' }, 400);
    }
    const promptText = form.get('promptText');
    const promptLang = form.get('promptLang');
    if (typeof promptText !== 'string' || promptText.length === 0) {
      return c.json({ error: 'missing_promptText' }, 400);
    }
    if (typeof promptLang !== 'string' || promptLang.length === 0) {
      return c.json({ error: 'missing_promptLang' }, 400);
    }

    const label = typeof form.get('label') === 'string'
      ? (form.get('label') as string)
      : (file instanceof File ? file.name : 'untitled');
    const setPrimary = form.get('setPrimary') === 'true'
                    || form.get('setPrimary') === '1';

    const refId    = `ra_${randomUUID().slice(0, 8)}`;
    const ext      = extForMime(file.type || mimeForExt(path.extname(label).slice(1)));
    const cardDir  = voiceRefsForCard(found.id);
    fs.mkdirSync(cardDir, { recursive: true });
    const relPath  = `${found.id as string}/${refId}.${ext}`;
    const absPath  = path.join(cardDir, `${refId}.${ext}`);

    const bytes = new Uint8Array(await file.arrayBuffer());
    await fs.promises.writeFile(absPath, bytes);

    const newRef: CharacterRefAudio = {
      id:           refId,
      label,
      refAudioPath: relPath,
      promptText,
      promptLang,
    };

    const profile = found.card.voiceProfile;
    const nextProfile: CharacterVoiceProfile = {
      refAudios: [...profile.refAudios, newRef],
      primaryId: setPrimary || profile.primaryId === null
        ? refId
        : profile.primaryId,
    };
    bindings.card.update(found.id, { voiceProfile: nextProfile });

    return c.json({ ref: newRef, primaryId: nextProfile.primaryId }, 201);
  });

  // ── download ─────────────────────────────────────────────────────────────
  app.get('/:cardId/voice-refs/:refId', async (c) => {
    const found = getCardOr404(bindings, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);

    const refId = c.req.param('refId');
    const ref = found.card.voiceProfile.refAudios.find((r) => r.id === refId);
    if (!ref) return c.json({ error: 'ref_not_found' }, 404);

    const absPath = resolveVoiceRefPath(ref.refAudioPath);
    if (!fs.existsSync(absPath)) return c.json({ error: 'file_missing' }, 410);

    const stat = await fs.promises.stat(absPath);
    const stream = fs.createReadStream(absPath);
    const ext = path.extname(absPath).slice(1).toLowerCase();
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type':   mimeForExt(ext),
        'Content-Length': String(stat.size),
        'Cache-Control':  'private, max-age=0',
      },
    });
  });

  // ── delete ───────────────────────────────────────────────────────────────
  app.delete('/:cardId/voice-refs/:refId', (c) => {
    const found = getCardOr404(bindings, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);

    const refId = c.req.param('refId');
    const ref = found.card.voiceProfile.refAudios.find((r) => r.id === refId);
    if (!ref) return c.json({ error: 'ref_not_found' }, 404);

    // Remove file (tolerate already-gone files)
    const absPath = resolveVoiceRefPath(ref.refAudioPath);
    try { fs.rmSync(absPath, { force: true }); } catch { /* ignore */ }

    const nextRefs = found.card.voiceProfile.refAudios.filter((r) => r.id !== refId);
    const nextPrimary = found.card.voiceProfile.primaryId === refId
      ? (nextRefs[0]?.id ?? null)
      : found.card.voiceProfile.primaryId;
    bindings.card.update(found.id, {
      voiceProfile: { refAudios: nextRefs, primaryId: nextPrimary },
    });

    return c.body(null, 204);
  });

  // ── set primary ──────────────────────────────────────────────────────────
  app.put('/:cardId/voice-refs/primary', async (c) => {
    const found = getCardOr404(bindings, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);

    const body = await c.req.json().catch(() => null) as { refId?: string } | null;
    if (!body || typeof body.refId !== 'string') {
      return c.json({ error: 'missing_refId' }, 400);
    }
    if (!found.card.voiceProfile.refAudios.some((r) => r.id === body.refId)) {
      return c.json({ error: 'ref_not_found' }, 404);
    }

    bindings.card.update(found.id, {
      voiceProfile: { ...found.card.voiceProfile, primaryId: body.refId },
    });
    return c.json({ primaryId: body.refId });
  });

  return app;
}
