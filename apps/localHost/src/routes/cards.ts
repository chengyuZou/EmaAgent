// 提供角色卡 CRUD、参考音频与 Live2D 资源的 LocalHost HTTP 适配。
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';

import {
  asCharacterCardId,
  asCharacterVoiceReferenceId,
} from '@ema-agent/ids';
import type { CharacterCardStore } from '@ema-agent/characters';
import { cardDir, cardResourcePath, resolveCardVoiceRefPath } from '../storage-locations/index.js';
import { REQUEST_VALUE_LIMITS } from '../http/request-budget.js';
import { z } from 'zod';

// ── Helpers ─────────────────────────────────────────────────────────────────

function getCardOr404(cardStore: CharacterCardStore, idStr: string) {
  const id = asCharacterCardId(idStr);
  const card = cardStore.get(id);
  return card ? { id, card } : null;
}

// ── Card CRUD schemas ──────────────────────────────────────────────────────

const createCardSchema = z.object({
  name:              z.string().min(1).max(200),
  version:           z.string().max(50).optional(),
  description:       z.string().max(1000).optional().nullable(),
  systemPrompt:      z.string().min(1),
  speechPatterns:    z.array(z.string()).optional(),
  forbiddenTopics:   z.array(z.string()).optional(),
  emotionVocabulary: z.array(z.string()).optional(),
  motionVocabulary:  z.array(z.string()).optional(),
}).strict();

// 资源不混入角色卡元数据；参考音频在角色创建后通过独立子资源接口维护。
const patchCardSchema = z.object({
  name:              z.string().min(1).max(200).optional(),
  version:           z.string().max(50).optional(),
  description:       z.string().max(1000).optional().nullable(),
  systemPrompt:      z.string().min(1).optional(),
  speechPatterns:    z.array(z.string()).optional(),
  forbiddenTopics:   z.array(z.string()).optional(),
  emotionVocabulary: z.array(z.string()).optional(),
  motionVocabulary:  z.array(z.string()).optional(),
}).strict();

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
 *
 * Card CRUD:
 *   GET    /                          list all cards
 *   GET    /:id                       get one card
 *   POST   /                          create card
 *   PATCH  /:id                       update card metadata
 *   DELETE /:id                       delete card
 *   PUT    /:id/activate              set as globally active card
 *
 * Voice-refs (sub-resource of card):
 *   GET    /:cardId/voice-refs            list refs (no audio bytes)
 *   POST   /:cardId/voice-refs            multipart upload — adds a new ref
 *   GET    /:cardId/voice-refs/:refId     stream audio bytes
 *   DELETE /:cardId/voice-refs/:refId     remove ref entry + file
 *   PUT    /:cardId/voice-refs/primary    body: { refId } — switch primary
 */
export function cardsRoute(cardStore: CharacterCardStore): Hono {
  const app = new Hono();

  // ═══════════════════════════════════════════════════════════════════════
  // Card CRUD
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/', (c) => {
    return c.json(cardStore.list());
  });

  app.get('/:id', (c) => {
    const card = cardStore.get(asCharacterCardId(c.req.param('id')));
    if (!card) return c.json({ error: 'card_not_found' }, 404);
    return c.json(card);
  });

  app.post('/', async (c) => {
    const body = createCardSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    const card = cardStore.create({
      ...body.data,
      description: body.data.description ?? undefined,
      version: body.data.version ?? '1.0',
    });
    return c.json(card, 201);
  });

  app.patch('/:id', async (c) => {
    const id = asCharacterCardId(c.req.param('id'));
    const body = patchCardSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    // B-055:不把 null 转 undefined —— storage update 用 `!== undefined` 判断,
    // null 会 SET NULL(清空),undefined 跳过(不更新)。`?? undefined` 会让清空失败。
    const card = cardStore.update(id, body.data);
    return c.json(card);
  });

  app.delete('/:id', (c) => {
    const id = asCharacterCardId(c.req.param('id'));
    const card = cardStore.get(id);
    if (!card) return c.json({ error: 'card_not_found' }, 404);
    if (card.isBuiltin) return c.json({ error: 'cannot_delete_builtin_card' }, 403);
    // B-055:禁止删除当前 active 卡,否则留下零 active 状态。用户须先 activate 别的卡。
    if (card.isActive) return c.json({ error: 'cannot_delete_active_card' }, 409);
    cardStore.delete(id);
    return c.body(null, 204);
  });

  app.put('/:id/activate', (c) => {
    const id = asCharacterCardId(c.req.param('id'));
    const card = cardStore.get(id);
    if (!card) return c.json({ error: 'card_not_found' }, 404);
    cardStore.activate(id);
    return c.json({ activeCardId: id as string });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Voice-refs
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/:cardId/voice-refs', (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);
    return c.json(found.card.voiceReferences);
  });

  app.post('/:cardId/voice-refs', async (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);
    if (found.card.isBuiltin) return c.json({ error: 'builtin_readonly' }, 403);

    let form: FormData;
    try { form = await c.req.formData(); }
    catch { return c.json({ error: 'invalid_multipart' }, 400); }

    const file = form.get('file') as unknown;
    if (!(file instanceof File) && !(file instanceof Blob)) {
      return c.json({ error: 'missing_file_field' }, 400);
    }
    if (file.size > REQUEST_VALUE_LIMITS.maxCardVoiceFileBytes) {
      return c.json({
        error: 'payload_too_large',
        message: `参考音频超过 ${REQUEST_VALUE_LIMITS.maxCardVoiceFileBytes} 字节限制`,
        maxBytes: REQUEST_VALUE_LIMITS.maxCardVoiceFileBytes,
      }, 413);
    }
    const promptText = form.get('promptText');
    const promptLang = form.get('promptLang');
    if (typeof promptText !== 'string' || promptText.length === 0) {
      return c.json({ error: 'missing_promptText' }, 400);
    }
    if (promptText.length > REQUEST_VALUE_LIMITS.maxCardVoicePromptChars) {
      return c.json({ error: 'promptText_too_long' }, 400);
    }
    if (typeof promptLang !== 'string' || promptLang.length === 0) {
      return c.json({ error: 'missing_promptLang' }, 400);
    }

    const label = typeof form.get('label') === 'string'
      ? (form.get('label') as string)
      : (file instanceof File ? file.name : 'untitled');
    const setPrimary = form.get('setPrimary') === 'true'
                    || form.get('setPrimary') === '1';

    const refId = asCharacterVoiceReferenceId(`ra_${randomUUID().slice(0, 8)}`);
    const ext     = extForMime(file.type || mimeForExt(path.extname(label).slice(1)));
    const voiceDir = path.join(cardDir(found.id as string, found.card.isBuiltin), 'voiceRefs');
    fs.mkdirSync(voiceDir, { recursive: true });
    const relPath = `voiceRefs/${refId}.${ext}`;
    const absPath = path.join(voiceDir, `${refId}.${ext}`);

    const bytes = new Uint8Array(await file.arrayBuffer());
    await fs.promises.writeFile(absPath, bytes);

    let newRef;
    try {
      newRef = cardStore.addVoiceReference(found.id, {
        id: refId,
        label,
        relativePath: relPath,
        promptText,
        promptLang,
        isPrimary: setPrimary || found.card.voiceReferences.length === 0,
        mimeType: file.type || mimeForExt(ext),
        byteSize: file.size,
      });
    } catch (error) {
      await fs.promises.rm(absPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return c.json({
      reference: newRef,
      primaryId: cardStore.get(found.id)?.voiceReferences
        .find((reference) => reference.isPrimary)?.id ?? null,
    }, 201);
  });

  app.get('/:cardId/voice-refs/:refId', async (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);

    const refId = asCharacterVoiceReferenceId(c.req.param('refId'));
    const ref = found.card.voiceReferences.find((reference) => reference.id === refId);
    if (!ref) return c.json({ error: 'ref_not_found' }, 404);

    // 相对路径来自显式资源记录，文件读取前仍再次限制在角色 voiceRefs 目录。
    let absPath: string;
    try {
      absPath = resolveCardVoiceRefPath(
        found.id,
        found.card.isBuiltin,
        ref.relativePath,
      );
    } catch {
      return c.json({ error: 'invalid_voice_ref_path' }, 400);
    }
    if (!fs.existsSync(absPath)) return c.json({ error: 'file_missing' }, 410);

    const stat = await fs.promises.stat(absPath);
    const stream = fs.createReadStream(absPath);
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type': ref.mimeType,
        'Content-Length': String(stat.size),
        'Cache-Control': 'private, max-age=0',
      },
    });
  });

  app.delete('/:cardId/voice-refs/:refId', (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);
    if (found.card.isBuiltin) return c.json({ error: 'builtin_readonly' }, 403);

    const refId = asCharacterVoiceReferenceId(c.req.param('refId'));
    const ref = found.card.voiceReferences.find((reference) => reference.id === refId);
    if (!ref) return c.json({ error: 'ref_not_found' }, 404);

    let absPath: string;
    try {
      absPath = resolveCardVoiceRefPath(
        found.id,
        found.card.isBuiltin,
        ref.relativePath,
      );
    } catch {
      return c.json({ error: 'invalid_voice_ref_path' }, 400);
    }

    const deleted = cardStore.deleteVoiceReference(found.id, refId);
    if (!deleted) return c.json({ error: 'ref_not_found' }, 404);
    try { fs.rmSync(absPath, { force: true }); } catch { /* 孤儿文件由后续资源自检回收。 */ }

    return c.body(null, 204);
  });

  app.put('/:cardId/voice-refs/primary', async (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);

    const body = await c.req.json().catch(() => null) as { refId?: string } | null;
    if (!body || typeof body.refId !== 'string') {
      return c.json({ error: 'missing_refId' }, 400);
    }

    const refId = asCharacterVoiceReferenceId(body.refId);
    if (!cardStore.setPrimaryVoiceReference(found.id, refId)) {
      return c.json({ error: 'ref_not_found' }, 404);
    }
    return c.json({ primaryId: refId });
  });

  // ── Live2D model path + runtime config ──────────────────────────────────────

  /**
   * GET /:cardId/live2d/model-path
   * Returns the web-accessible path for the card's selected Live2D model.
   */
  app.get('/:cardId/live2d/model-path', (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);
    const model = selectedLive2dVariant(found.card.live2dVariants);
    if (!model) return c.json({ error: 'no_live2d_model' }, 404);

    if (found.card.isBuiltin) {
      return c.json({ path: `/cards/${found.id}/${model.entryPath}` });
    }
    return c.json({
      path: cardResourcePath(found.id, false, model.entryPath),
    });
  });

  app.get('/:cardId/live2d/runtime-config', async (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);
    const model = selectedLive2dVariant(found.card.live2dVariants);
    if (!model) return c.json({ error: 'no_live2d_model' }, 404);
    if (!model.runtimeConfigPath) {
      return c.json({ error: 'runtime_config_missing' }, 404);
    }

    const configPath = cardResourcePath(
      found.id,
      found.card.isBuiltin,
      model.runtimeConfigPath,
    );
    try {
      const content = await fs.promises.readFile(configPath, 'utf-8');
      return c.json(JSON.parse(content));
    } catch {
      return c.json({ error: 'runtime_config_missing' }, 404);
    }
  });

  return app;
}

function selectedLive2dVariant<T extends {
  isPrimary: boolean;
  enabled: boolean;
}>(variants: readonly T[]): T | undefined {
  return variants.find((variant) => variant.enabled && variant.isPrimary)
    ?? variants.find((variant) => variant.enabled);
}
