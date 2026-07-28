// 校验模型绑定 HTTP 输入，并交给控制面执行原子替换、追加或删除。
import { Hono } from 'hono';
import { z } from 'zod';
import {
  MODEL_BINDING_MODULES,
  type ModelBindingControl,
  type ModelBindingModule,
} from '@ema-agent/provider';

const moduleSchema = z.enum(MODEL_BINDING_MODULES);

const upsertSchema = z.object({
  providerConfigId: z.string().min(1),
  model: z.string().min(1),
  embeddingDimension: z.number().int().positive().optional(),
}).strict();

const deleteQuerySchema = z.object({
  providerConfigId: z.string().min(1),
  model: z.string().min(1),
});

export function modelBindingMutationsRoute(
  bindings: ModelBindingControl,
): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(bindings.list()));

  app.get('/:module', (c) => {
    const module = parseModule(c.req.param('module'));
    if (!module) {
      return c.json({
        error: 'invalid_module',
        validModules: MODEL_BINDING_MODULES,
      }, 400);
    }
    return c.json(bindings.listByModule(module));
  });

  app.put('/:module/set', async (c) => {
    const module = parseModule(c.req.param('module'));
    if (!module) {
      return c.json({
        error: 'invalid_module',
        validModules: MODEL_BINDING_MODULES,
      }, 400);
    }
    const body = upsertSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    return c.json(bindings.setSingle({ module, ...body.data }));
  });

  app.put('/:module', async (c) => {
    const module = parseModule(c.req.param('module'));
    if (!module) {
      return c.json({
        error: 'invalid_module',
        validModules: MODEL_BINDING_MODULES,
      }, 400);
    }
    const body = upsertSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.flatten() }, 400);
    }
    return c.json(bindings.upsert({ module, ...body.data }));
  });

  app.delete('/:module', (c) => {
    const module = parseModule(c.req.param('module'));
    if (!module) {
      return c.json({
        error: 'invalid_module',
        validModules: MODEL_BINDING_MODULES,
      }, 400);
    }
    const query = deleteQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: 'invalid_request', details: query.error.flatten() }, 400);
    }
    bindings.delete(module, query.data.providerConfigId, query.data.model);
    return c.body(null, 204);
  });

  return app;
}

function parseModule(value: string): ModelBindingModule | undefined {
  const parsed = moduleSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
