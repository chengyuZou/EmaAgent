import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';

import type { AppBindings } from '../wiring.js';
import {
  asCharacterCardId,
  emptyVoiceProfile,
  type CharacterRefAudio,
  type CharacterVoiceProfile,
} from '@ema-agent/contracts';
import { voiceRefsForCard, resolveVoiceRefPath } from '../storage-locations/index.js';
import { z } from 'zod';

// ── Helpers ─────────────────────────────────────────────────────────────────

function getCardOr404(bindings: AppBindings, idStr: string) {
  const id = asCharacterCardId(idStr);
  const card = bindings.card.get(id);
  return card ? { id, card } : null;
}

// ── Card CRUD schemas ──────────────────────────────────────────────────────

const createCardSchema = z.object({
  name:             z.string().min(1).max(200),
  version:          z.string().max(50).optional(),
  description:      z.string().max(1000).optional().nullable(),
  systemPrompt:     z.string().min(1),
  speechPatterns:   z.array(z.string()).optional(),
  forbiddenTopics:  z.array(z.string()).optional(),
  emotionVocabulary: z.array(z.string()).optional(),
  motionVocabulary:  z.array(z.string()).optional(),
  live2dModelId:    z.string().optional().nullable(),
  voiceProfile:     z.object({
    refAudios: z.array(z.object({
      id:           z.string(),
      label:        z.string(),
      refAudioPath: z.string(),
      promptText:   z.string(),
      promptLang:   z.string(),
    })),
    primaryId: z.string().nullable(),
  }).optional(),
});

const patchCardSchema = z.object({
  name:             z.string().min(1).max(200).optional(),
  version:          z.string().max(50).optional(),
  description:      z.string().max(1000).optional().nullable(),
  systemPrompt:     z.string().min(1).optional(),
  speechPatterns:   z.array(z.string()).optional(),
  forbiddenTopics:  z.array(z.string()).optional(),
  emotionVocabulary: z.array(z.string()).optional(),
  motionVocabulary:  z.array(z.string()).optional(),
  live2dModelId:    z.string().optional().nullable(),
  voiceProfile:     z.object({
    refAudios: z.array(z.object({
      id:           z.string(),
      label:        z.string(),
      refAudioPath: z.string(),
      promptText:   z.string(),
      promptLang:   z.string(),
    })).optional(),
    primaryId: z.string().nullable().optional(),
  }).optional(),
});

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
 */
export function voiceRefsRoute(bindings: AppBindings): Hono {
  const app = new Hono();

  // ═══════════════════════════════════════════════════════════════════════
  // Card CRUD
  // ═══════════════════════════════════════════════════════════════════════

  // ── GET / — list all cards ──────────────────────────────────────────
  app.get('/', (c) => {
    return c.json(bindings.card.list());
  });

  // ── GET /:id — get one card ─────────────────────────────────────────
  app.get('/:id', (c) => {
    const card = bindings.card.get(asCharacterCardId(c.req.param('id')));
    if (!card) return c.json({ error: 'card_not_found' }, 404);
    return c.json(card);
  });

  // ── POST / — create card ────────────────────────────────────────────
  app.post('/', async (c) => {
    const body = createCardSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    const card = bindings.card.create({
      ...body.data,
      description:   body.data.description ?? undefined,
      live2dModelId: body.data.live2dModelId ?? undefined,
      voiceProfile:  body.data.voiceProfile ?? emptyVoiceProfile(),
      version:       body.data.version ?? '1.0',
    });
    return c.json(card, 201);
  });

  // ── PATCH /:id — update card ────────────────────────────────────────
  app.patch('/:id', async (c) => {
    const id = asCharacterCardId(c.req.param('id'));
    const body = patchCardSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    const { voiceProfile: _vp, ...rest } = body.data;
    const card = bindings.card.update(id, {
      ...rest,
      description:   body.data.description ?? undefined,
      live2dModelId: body.data.live2dModelId ?? undefined,
    });
    return c.json(card);
  });

  // ── DELETE /:id — delete card ───────────────────────────────────────
  app.delete('/:id', (c) => {
    const id = asCharacterCardId(c.req.param('id'));
    const card = bindings.card.get(id);
    if (!card) return c.json({ error: 'card_not_found' }, 404);
    if (card.isBuiltin) return c.json({ error: 'cannot_delete_builtin_card' }, 403);
    bindings.card.delete(id);
    return c.body(null, 204);
  });

  // ── PUT /:id/activate — set as active ───────────────────────────────
  app.put('/:id/activate', (c) => {
    const id = asCharacterCardId(c.req.param('id'));
    const card = bindings.card.get(id);
    if (!card) return c.json({ error: 'card_not_found' }, 404);
    bindings.card.activate(id);
    return c.json({ activeCardId: id as string });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Voice-refs
  // ═══════════════════════════════════════════════════════════════════════

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
