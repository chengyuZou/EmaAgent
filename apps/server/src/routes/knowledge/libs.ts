// 知识库注册表管理：列表、创建、改名、激活与注销（注销先停队列再关库，由 KbManager 保证）。
import { Hono } from 'hono';
import { z } from 'zod';
import type { KbManager } from '@ema-agent/knowledge';
import { knowledgeError } from './errors.js';

export interface KnowledgeLibsRouteDeps {
  readonly kb: Pick<
    KbManager,
    'listKbs' | 'getKb' | 'createKb' | 'renameKb' | 'setActiveKb' | 'unregisterKb'
  >;
}

const createBody = z.object({
  name: z.string().min(1).max(100),
  path: z.string().min(1),
});

const renameBody = z.object({
  name: z.string().min(1).max(100),
});

export function knowledgeLibsRoute(deps: KnowledgeLibsRouteDeps): Hono {
  const app = new Hono();

  app.get('/libs', context => {
    return context.json({ items: deps.kb.listKbs() });
  });

  app.post('/libs', async context => {
    const parsed = createBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      return context.json(await deps.kb.createKb(parsed.data.name, parsed.data.path), 201);
    } catch (error) {
      const mapped = knowledgeError(context, error);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.patch('/libs/:id', async context => {
    const parsed = renameBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    if (!deps.kb.getKb(context.req.param('id'))) {
      return context.json({ error: 'kb_not_found' }, 404);
    }
    deps.kb.renameKb(context.req.param('id'), parsed.data.name);
    return context.json({ ok: true });
  });

  app.post('/libs/:id/activate', context => {
    if (!deps.kb.setActiveKb(context.req.param('id'))) {
      return context.json({ error: 'kb_not_found' }, 404);
    }
    return context.json({ ok: true });
  });

  app.delete('/libs/:id', async context => {
    if (!deps.kb.getKb(context.req.param('id'))) {
      return context.json({ error: 'kb_not_found' }, 404);
    }
    await deps.kb.unregisterKb(context.req.param('id'));
    return context.json({ ok: true });
  });

  return app;
}
