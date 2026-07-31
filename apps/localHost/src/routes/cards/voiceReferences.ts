// 参考音频子资源的 HTTP 适配:multipart 上传、试听流、删除与设为主用。
// 与 cards/resources.ts 的能力句柄导入导出并存:这里是既有上传与播放接口,
// 前端统一交互前不做机械合并。
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  asCharacterCardId,
  asCharacterVoiceReferenceId,
} from '@ema-agent/ids';
import { type CharacterCardStore } from '@ema-agent/characters';
import { REQUEST_VALUE_LIMITS } from '../../http/request-budget.js';

function getCardOr404(cardStore: CharacterCardStore, idStr: string) {
  const id = asCharacterCardId(idStr);
  const card = cardStore.get(id);
  return card ? { id, card } : null;
}

/**
 * Endpoints:
 *   GET    /:cardId/voice-refs            list refs (no audio bytes)
 *   POST   /:cardId/voice-refs            multipart upload — adds a new ref
 *   GET    /:cardId/voice-refs/:refId     stream audio bytes
 *   DELETE /:cardId/voice-refs/:refId     remove ref entry + file
 *   PUT    /:cardId/voice-refs/primary    body: { refId } — switch primary
 */
export function voiceReferencesRoute(cardStore: CharacterCardStore): Hono {
  const app = new Hono();

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
    // 受管文件名不信任客户端扩展名；真实格式在暂存阶段按文件头写入 SQL。
    const relPath = `voiceRefs/${refId}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const current = cardStore.get(found.id);
    if (!current) throw new Error(`character card not found: ${found.id}`);
    const newRef = await cardStore.publishVoiceReference(found.id, {
      id: refId,
      label,
      relativePath: relPath,
      promptText,
      promptLang,
      isPrimary: setPrimary || current.voiceReferences.length === 0,
      mimeType: 'application/octet-stream',
      byteSize: file.size,
    }, bytes);
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
      absPath = cardStore.resolveResourcePath(
        found.id,
        ref.relativePath,
        'voiceReference',
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

  app.delete('/:cardId/voice-refs/:refId', async (c) => {
    const found = getCardOr404(cardStore, c.req.param('cardId'));
    if (!found) return c.json({ error: 'card_not_found' }, 404);
    if (found.card.isBuiltin) return c.json({ error: 'builtin_readonly' }, 403);

    const refId = asCharacterVoiceReferenceId(c.req.param('refId'));
    const ref = found.card.voiceReferences.find((reference) => reference.id === refId);
    if (!ref) return c.json({ error: 'ref_not_found' }, 404);

    try {
      cardStore.resolveResourcePath(
        found.id,
        ref.relativePath,
        'voiceReference',
      );
    } catch {
      return c.json({ error: 'invalid_voice_ref_path' }, 400);
    }

    const deleted = await cardStore.deleteManagedVoiceReference(found.id, refId);
    if (!deleted) return c.json({ error: 'ref_not_found' }, 404);
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

  return app;
}
