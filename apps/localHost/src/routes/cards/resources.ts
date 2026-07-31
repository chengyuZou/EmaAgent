// 把用户授权的本地资源交给 Character 领域导入、导出或删除，不在 HTTP 层复制文件业务。

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { FileAccessFacade } from '@ema-agent/attachment';
import {
  CharacterResourcePathError,
  CharacterResourceValidationError,
  type CharacterCardStore,
} from '@ema-agent/characters';
import {
  asCharacterCardId,
  asCharacterLive2dId,
  asCharacterPortraitId,
  asCharacterVoiceReferenceId,
} from '@ema-agent/ids';

const live2dImportSchema = z.object({
  sourceHandle: z.string().min(1),
  label: z.string().trim().min(1).max(200),
  format: z.enum(['live2d', 'vrm']),
  entryRelativePath: z.string().min(1).max(240),
  runtimeConfigRelativePath: z.string().min(1).max(240).nullable().optional(),
  position: z.number().int().min(0).optional(),
  isPrimary: z.boolean().optional(),
}).strict();

const portraitImportSchema = z.object({
  sourceHandle: z.string().min(1),
  label: z.string().trim().min(1).max(200),
  position: z.number().int().min(0).optional(),
  isPrimary: z.boolean().optional(),
}).strict();

const voiceImportSchema = z.object({
  sourceHandle: z.string().min(1),
  label: z.string().trim().min(1).max(200),
  promptText: z.string().trim().min(1).max(10_000),
  promptLang: z.string().trim().min(1).max(64),
  position: z.number().int().min(0).optional(),
  isPrimary: z.boolean().optional(),
}).strict();

const exportSchema = z.object({
  destinationHandle: z.string().min(1),
}).strict();

const resourcePatchSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  position: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  enabled: z.boolean().optional(),
}).strict().refine(
  value => (
    value.label !== undefined
    || value.position !== undefined
    || value.enabled !== undefined
  ),
  { message: 'at least one resource field is required' },
);

export function characterResourcesRoute(
  cardStore: CharacterCardStore,
  fileAccess: Pick<FileAccessFacade, 'resolve'>,
): Hono {
  const app = new Hono();

  app.get('/:cardId/live2d', (c) => {
    const cardId = asCharacterCardId(c.req.param('cardId'));
    if (!cardStore.get(cardId)) return c.json({ error: 'card_not_found' }, 404);
    return c.json(cardStore.listLive2dVariants(cardId));
  });

  app.post('/:cardId/live2d/import', async (c) => {
    const parsed = live2dImportSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());
    const cardId = asCharacterCardId(c.req.param('cardId'));
    if (!cardStore.get(cardId)) return c.json({ error: 'card_not_found' }, 404);
    return runResourceRequest(c, async () => {
      const resource = await cardStore.importLive2dDirectory(cardId, {
        ...parsed.data,
        sourceDirectory: fileAccess.resolve(parsed.data.sourceHandle),
      });
      return c.json({ resource }, 201);
    });
  });

  app.post('/:cardId/live2d/:resourceId/export', async (c) => {
    const parsed = exportSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());
    const cardId = asCharacterCardId(c.req.param('cardId'));
    return runResourceRequest(c, async () => {
      const destinationPath = await cardStore.exportLive2dDirectory(
        cardId,
        asCharacterLive2dId(c.req.param('resourceId')),
        fileAccess.resolve(parsed.data.destinationHandle),
      );
      return c.json({ destinationPath });
    });
  });

  app.patch('/:cardId/live2d/:resourceId', async (c) => {
    const parsed = resourcePatchSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());
    const cardId = asCharacterCardId(c.req.param('cardId'));
    return runResourceRequest(c, async () => {
      const resource = cardStore.updateLive2dVariant(
        cardId,
        asCharacterLive2dId(c.req.param('resourceId')),
        parsed.data,
      );
      return resource
        ? c.json({ resource })
        : c.json({ error: 'live2d_not_found' }, 404);
    });
  });

  app.delete('/:cardId/live2d/:resourceId', async (c) => {
    const cardId = asCharacterCardId(c.req.param('cardId'));
    return runResourceRequest(c, async () => {
      const deleted = await cardStore.deleteManagedLive2dVariant(
        cardId,
        asCharacterLive2dId(c.req.param('resourceId')),
      );
      return deleted ? c.body(null, 204) : c.json({ error: 'live2d_not_found' }, 404);
    });
  });

  app.get('/:cardId/portraits', (c) => {
    const cardId = asCharacterCardId(c.req.param('cardId'));
    if (!cardStore.get(cardId)) return c.json({ error: 'card_not_found' }, 404);
    return c.json(cardStore.listPortraits(cardId));
  });

  app.post('/:cardId/portraits/import', async (c) => {
    const parsed = portraitImportSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());
    const cardId = asCharacterCardId(c.req.param('cardId'));
    if (!cardStore.get(cardId)) return c.json({ error: 'card_not_found' }, 404);
    return runResourceRequest(c, async () => {
      const resource = await cardStore.importPortraitFile(cardId, {
        ...parsed.data,
        sourceFile: fileAccess.resolve(parsed.data.sourceHandle),
      });
      return c.json({ resource }, 201);
    });
  });

  app.post('/:cardId/portraits/:resourceId/export', async (c) => {
    const parsed = exportSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());
    const cardId = asCharacterCardId(c.req.param('cardId'));
    return runResourceRequest(c, async () => {
      const destinationPath = await cardStore.exportPortraitFile(
        cardId,
        asCharacterPortraitId(c.req.param('resourceId')),
        fileAccess.resolve(parsed.data.destinationHandle),
      );
      return c.json({ destinationPath });
    });
  });

  app.patch('/:cardId/portraits/:resourceId', async (c) => {
    const parsed = resourcePatchSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());
    const cardId = asCharacterCardId(c.req.param('cardId'));
    return runResourceRequest(c, async () => {
      const resource = cardStore.updatePortrait(
        cardId,
        asCharacterPortraitId(c.req.param('resourceId')),
        parsed.data,
      );
      return resource
        ? c.json({ resource })
        : c.json({ error: 'portrait_not_found' }, 404);
    });
  });

  app.delete('/:cardId/portraits/:resourceId', async (c) => {
    const cardId = asCharacterCardId(c.req.param('cardId'));
    return runResourceRequest(c, async () => {
      const deleted = await cardStore.deleteManagedPortrait(
        cardId,
        asCharacterPortraitId(c.req.param('resourceId')),
      );
      return deleted ? c.body(null, 204) : c.json({ error: 'portrait_not_found' }, 404);
    });
  });

  app.post('/:cardId/voice-refs/import', async (c) => {
    const parsed = voiceImportSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());
    const cardId = asCharacterCardId(c.req.param('cardId'));
    if (!cardStore.get(cardId)) return c.json({ error: 'card_not_found' }, 404);
    return runResourceRequest(c, async () => {
      const resource = await cardStore.importVoiceReferenceFile(cardId, {
        ...parsed.data,
        sourceFile: fileAccess.resolve(parsed.data.sourceHandle),
      });
      return c.json({ resource }, 201);
    });
  });

  app.post('/:cardId/voice-refs/:resourceId/export', async (c) => {
    const parsed = exportSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());
    const cardId = asCharacterCardId(c.req.param('cardId'));
    return runResourceRequest(c, async () => {
      const destinationPath = await cardStore.exportVoiceReferenceFile(
        cardId,
        asCharacterVoiceReferenceId(c.req.param('resourceId')),
        fileAccess.resolve(parsed.data.destinationHandle),
      );
      return c.json({ destinationPath });
    });
  });

  app.patch('/:cardId/voice-refs/:resourceId', async (c) => {
    const parsed = resourcePatchSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());
    const cardId = asCharacterCardId(c.req.param('cardId'));
    return runResourceRequest(c, async () => {
      const resource = cardStore.updateVoiceReference(
        cardId,
        asCharacterVoiceReferenceId(c.req.param('resourceId')),
        parsed.data,
      );
      return resource
        ? c.json({ resource })
        : c.json({ error: 'voice_ref_not_found' }, 404);
    });
  });

  return app;
}

async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null);
}

function invalidRequest(
  c: Context,
  details: unknown,
) {
  return c.json({ error: 'invalid_request', details }, 400);
}

async function runResourceRequest<T>(
  c: Context,
  operation: () => Promise<T>,
): Promise<T | Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CharacterResourceValidationError) {
      const status = error.reason.includes('too_large') ? 413 : 400;
      return c.json({ error: error.code, reason: error.reason }, status);
    }
    if (error instanceof CharacterResourcePathError) {
      return c.json({ error: error.code, reason: error.reason }, 400);
    }
    if (error instanceof Error && error.message.includes('read-only')) {
      return c.json({ error: 'builtin_readonly' }, 403);
    }
    if (error instanceof Error && error.message.includes('not found')) {
      return c.json({ error: 'resource_not_found' }, 404);
    }
    throw error;
  }
}
