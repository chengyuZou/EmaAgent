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
  asCharacterIllustrationId,
  asCharacterVoiceReferenceId,
} from '@ema-agent/ids';

const live2dImportSchema = z.object({
  sourceHandle: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  isPrimary: z.boolean().optional(),
}).strict();

const illustrationImportSchema = z.object({
  sourceHandle: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  isPrimary: z.boolean().optional(),
}).strict();

const voiceImportSchema = z.object({
  sourceHandle: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  promptText: z.string().trim().min(1).max(10_000),
  promptLang: z.string().trim().min(1).max(64),
  isPrimary: z.boolean().optional(),
}).strict();

const exportSchema = z.object({
  destinationHandle: z.string().min(1),
}).strict();

const resourcePatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  stageScale: z.number().min(0.1).max(5).optional(),
  stageOffsetX: z.number().min(-1).max(1).optional(),
  stageOffsetY: z.number().min(-1).max(1).optional(),
  enabled: z.boolean().optional(),
}).strict().refine(
  value => (
    value.name !== undefined
    || value.stageScale !== undefined
    || value.stageOffsetX !== undefined
    || value.stageOffsetY !== undefined
    || value.enabled !== undefined
  ),
  { message: 'at least one resource field is required' },
);

const voicePatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
}).strict().refine(
  value => value.name !== undefined || value.enabled !== undefined,
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

  app.get('/:cardId/illustration', (c) => {
    const cardId = asCharacterCardId(c.req.param('cardId'));
    if (!cardStore.get(cardId)) return c.json({ error: 'card_not_found' }, 404);
    return c.json(cardStore.listIllustrations(cardId));
  });

  app.post('/:cardId/illustration/import', async (c) => {
    const parsed = illustrationImportSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());
    const cardId = asCharacterCardId(c.req.param('cardId'));
    if (!cardStore.get(cardId)) return c.json({ error: 'card_not_found' }, 404);
    return runResourceRequest(c, async () => {
      const resource = await cardStore.importIllustrationFile(cardId, {
        ...parsed.data,
        sourceFile: fileAccess.resolve(parsed.data.sourceHandle),
      });
      return c.json({ resource }, 201);
    });
  });

  app.post('/:cardId/illustration/:resourceId/export', async (c) => {
    const parsed = exportSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());
    const cardId = asCharacterCardId(c.req.param('cardId'));
    return runResourceRequest(c, async () => {
      const destinationPath = await cardStore.exportIllustrationFile(
        cardId,
        asCharacterIllustrationId(c.req.param('resourceId')),
        fileAccess.resolve(parsed.data.destinationHandle),
      );
      return c.json({ destinationPath });
    });
  });

  app.patch('/:cardId/illustration/:resourceId', async (c) => {
    const parsed = resourcePatchSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());
    const cardId = asCharacterCardId(c.req.param('cardId'));
    return runResourceRequest(c, async () => {
      const resource = cardStore.updateIllustration(
        cardId,
        asCharacterIllustrationId(c.req.param('resourceId')),
        parsed.data,
      );
      return resource
        ? c.json({ resource })
        : c.json({ error: 'illustration_not_found' }, 404);
    });
  });

  app.delete('/:cardId/illustration/:resourceId', async (c) => {
    const cardId = asCharacterCardId(c.req.param('cardId'));
    return runResourceRequest(c, async () => {
      const deleted = await cardStore.deleteManagedIllustration(
        cardId,
        asCharacterIllustrationId(c.req.param('resourceId')),
      );
      return deleted ? c.body(null, 204) : c.json({ error: 'illustration_not_found' }, 404);
    });
  });

  app.post('/:cardId/voice/import', async (c) => {
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

  app.post('/:cardId/voice/:resourceId/export', async (c) => {
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

  app.patch('/:cardId/voice/:resourceId', async (c) => {
    const parsed = voicePatchSchema.safeParse(await readJson(c));
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
