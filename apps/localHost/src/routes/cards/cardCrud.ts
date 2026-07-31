// 角色卡 CRUD、激活、健康投影与资源操作状态的 HTTP 适配。
import { Hono } from 'hono';
import { z } from 'zod';
import { asCharacterCardId } from '@ema-agent/ids';
import {
  CharacterPromptInvalidError,
  type CharacterCardStore,
} from '@ema-agent/characters';

// ── Card CRUD schemas ──────────────────────────────────────────────────────

const createCardSchema = z.object({
  name:              z.string().trim().min(1).max(200),
  version:           z.string().max(50).optional(),
  description:       z.string().max(1000).optional().nullable(),
  systemPrompt:      z.string().refine((value) => value.trim().length > 0),
  speechPatterns:    z.array(z.string()).optional(),
  forbiddenTopics:   z.array(z.string()).optional(),
  emotionVocabulary: z.array(z.string()).optional(),
  motionVocabulary:  z.array(z.string()).optional(),
}).strict();

// 资源不混入角色卡元数据；参考音频在角色创建后通过独立子资源接口维护。
const patchCardSchema = z.object({
  name:              z.string().trim().min(1).max(200).optional(),
  version:           z.string().max(50).optional(),
  description:       z.string().max(1000).optional().nullable(),
  systemPrompt:      z.string().refine((value) => value.trim().length > 0).optional(),
  speechPatterns:    z.array(z.string()).optional(),
  forbiddenTopics:   z.array(z.string()).optional(),
  emotionVocabulary: z.array(z.string()).optional(),
  motionVocabulary:  z.array(z.string()).optional(),
}).strict();

/**
 * Endpoints:
 *   GET    /                          list all cards
 *   GET    /:id                       get one card
 *   GET    /:id/health                prompt + resource health projection
 *   GET    /:id/resource-operation    current/latest resource operation stage
 *   POST   /                          create card
 *   PATCH  /:id                       update card metadata
 *   DELETE /:id                       delete card (refuses builtin/active)
 *   PUT    /:id/activate              set as globally active card (health gate)
 */
export function cardCrudRoute(cardStore: CharacterCardStore): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(cardStore.list());
  });

  app.get('/:id', (c) => {
    const card = cardStore.get(asCharacterCardId(c.req.param('id')));
    if (!card) return c.json({ error: 'card_not_found' }, 404);
    return c.json(card);
  });

  app.get('/:id/health', async (c) => {
    const id = asCharacterCardId(c.req.param('id'));
    if (!cardStore.get(id)) return c.json({ error: 'card_not_found' }, 404);
    const deep = c.req.query('depth') === 'deep';
    return c.json(await cardStore.inspectHealth(id, deep));
  });

  app.get('/:id/resource-operation', (c) => {
    const id = asCharacterCardId(c.req.param('id'));
    if (!cardStore.get(id)) return c.json({ error: 'card_not_found' }, 404);
    return c.json({ operation: cardStore.inspectResourceOperation(id) ?? null });
  });

  app.post('/', async (c) => {
    const body = createCardSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    try {
      const card = cardStore.create({
        ...body.data,
        description: body.data.description ?? undefined,
        version: body.data.version ?? '1.0',
      });
      return c.json(card, 201);
    } catch (error) {
      if (error instanceof CharacterPromptInvalidError) {
        return c.json({ error: error.code }, 400);
      }
      throw error;
    }
  });

  app.patch('/:id', async (c) => {
    const id = asCharacterCardId(c.req.param('id'));
    const body = patchCardSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    // B-055:不把 null 转 undefined —— storage update 用 `!== undefined` 判断,
    // null 会 SET NULL(清空),undefined 跳过(不更新)。`?? undefined` 会让清空失败。
    try {
      const card = cardStore.update(id, body.data);
      return c.json(card);
    } catch (error) {
      if (error instanceof CharacterPromptInvalidError) {
        return c.json({ error: error.code }, 400);
      }
      throw error;
    }
  });

  app.delete('/:id', async (c) => {
    const id = asCharacterCardId(c.req.param('id'));
    const card = cardStore.get(id);
    if (!card) return c.json({ error: 'card_not_found' }, 404);
    if (card.isBuiltin) return c.json({ error: 'cannot_delete_builtin_card' }, 403);
    // B-055:禁止删除当前 active 卡,否则留下零 active 状态。用户须先 activate 别的卡。
    if (card.isActive) return c.json({ error: 'cannot_delete_active_card' }, 409);
    await cardStore.deleteManagedCharacter(id);
    return c.body(null, 204);
  });

  app.put('/:id/activate', async (c) => {
    const id = asCharacterCardId(c.req.param('id'));
    const card = cardStore.get(id);
    if (!card) return c.json({ error: 'card_not_found' }, 404);
    const health = await cardStore.inspectHealth(id, false);
    if (!health.executionAvailable) {
      return c.json({ error: 'character_not_executable', health }, 409);
    }
    cardStore.activate(id);
    return c.json({ activeCardId: id as string, health });
  });

  return app;
}
