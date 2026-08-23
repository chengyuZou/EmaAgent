// 角色 Prompt Block：增删改与排序；硬门校验归 CharacterStore。
import { Hono } from 'hono';
import { z } from 'zod';
import type { CharacterStore } from '@ema-agent/characters';
import { characterError } from './errors.js';

export interface CharacterPromptBlocksRouteDeps {
  readonly characters: Pick<
    CharacterStore,
    'addPromptBlock' | 'updatePromptBlock' | 'deletePromptBlock' | 'reorderPromptBlocks'
  >;
}

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  content: z.string().max(64_000),
  enabled: z.boolean().optional(),
});

const patchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  content: z.string().max(64_000).optional(),
  enabled: z.boolean().optional(),
});

const orderBody = z.object({
  orderedIds: z.array(z.string().min(1)).min(1).max(128),
});

export function characterPromptBlocksRoute(deps: CharacterPromptBlocksRouteDeps): Hono {
  const app = new Hono();

  app.post('/:id/blocks', async context => {
    const parsed = createBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      return context.json(deps.characters.addPromptBlock(context.req.param('id'), parsed.data), 201);
    } catch (error) {
      return characterError(context, error);
    }
  });

  app.patch('/:id/blocks/:blockId', async context => {
    const parsed = patchBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      const updated = deps.characters.updatePromptBlock(
        context.req.param('id'),
        context.req.param('blockId'),
        parsed.data,
      );
      if (!updated) return context.json({ error: 'block_not_found' }, 404);
      return context.json(updated);
    } catch (error) {
      return characterError(context, error);
    }
  });

  app.delete('/:id/blocks/:blockId', context => {
    try {
      const deleted = deps.characters.deletePromptBlock(
        context.req.param('id'),
        context.req.param('blockId'),
      );
      if (!deleted) return context.json({ error: 'block_not_found' }, 404);
      return context.json({ ok: true });
    } catch (error) {
      return characterError(context, error);
    }
  });

  // 排序提交完整 id 序列；与现有集合不一致即拒绝（不产生半个新顺序）。
  app.put('/:id/blocks/order', async context => {
    const parsed = orderBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      const reordered = deps.characters.reorderPromptBlocks(
        context.req.param('id'),
        parsed.data.orderedIds,
      );
      if (!reordered) return context.json({ error: 'order_mismatch' }, 409);
      return context.json({ ok: true });
    } catch (error) {
      return characterError(context, error);
    }
  });

  return app;
}
