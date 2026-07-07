import { Hono } from 'hono';
import { z }    from 'zod';
import type { AppBindings } from '../wiring/index.js';

// ── Market sources router ────────────────────────────────────────────────────
//
// 市场源 CRUD(MCP/Skill/未来 integration 共用)。源存 market_sources 表,
// adapter 注册在 MarketRegistry。本路由纯参数校验 + 协议转换,业务逻辑在
// MarketSourceStore + 各业务包 adapter.validateConfig。
//
// Routes:
//   GET    /api/market/sources?kind=mcp|skill   列源(可按 kind 过滤)
//   POST   /api/market/sources                  加源(用户自传):{ kind, type, label, config }
//   PATCH  /api/market/sources/:id              改 label / enabled / config / sortOrder
//   DELETE /api/market/sources/:id              删源(builtin 拒绝)
//   GET    /api/market/sources/:id/test         测试源连通性(调 adapter.list,返回条目数 / error)

const createBodySchema = z.object({
  kind:      z.string().min(1),
  type:      z.string().min(1),
  label:     z.string().min(1).max(100),
  config:    z.record(z.unknown()),
  sortOrder: z.number().int().optional(),
});

const patchBodySchema = z.object({
  label:     z.string().min(1).max(100).optional(),
  enabled:   z.boolean().optional(),
  config:    z.record(z.unknown()).optional(),
  sortOrder: z.number().int().optional(),
});

export function createMarketRouter(bindings: AppBindings) {
  const router = new Hono();
  const { marketSourceStore, marketRegistry } = bindings;

  // ── List sources ───────────────────────────────────────────────────────────
  router.get('/sources', (c) => {
    const kind = c.req.query('kind');
    const sources = kind ? marketSourceStore.list(kind) : marketSourceStore.list();
    return c.json({ sources });
  });

  // ── Create source ──────────────────────────────────────────────────────────
  router.post('/sources', async (c) => {
    let body: z.infer<typeof createBodySchema>;
    try {
      body = createBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    // 用对应 kind 的 adapter 校验 config(业务包各自规则)
    const adapter = marketRegistry.getAdapter(body.kind);
    if (!adapter) {
      return c.json({ error: `未知的市场 kind: ${body.kind}(未注册 adapter)` }, 400);
    }
    if (!adapter.types.includes(body.type)) {
      return c.json({ error: `kind "${body.kind}" 不支持 type "${body.type}",支持:${adapter.types.join(', ')}` }, 400);
    }
    const validated = adapter.validateConfig(body.type, body.config);
    if (!validated.ok) {
      return c.json({ error: validated.error }, 400);
    }

    const id = `user-${body.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const record = marketSourceStore.create({
      id,
      kind:      body.kind,
      type:      body.type,
      label:     body.label,
      config:    validated.config,
      sortOrder: body.sortOrder ?? 100,
      builtin:   false,
    });
    return c.json({ source: record }, 201);
  });

  // ── Update source ──────────────────────────────────────────────────────────
  router.patch('/sources/:id', async (c) => {
    const id = c.req.param('id');
    const existing = marketSourceStore.get(id);
    if (!existing) return c.json({ error: '源不存在' }, 404);

    let body: z.infer<typeof patchBodySchema>;
    try {
      body = patchBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    // 改 config 时重新校验(type 不变,用原 type)
    let configStr: string | undefined;
    if (body.config !== undefined) {
      const adapter = marketRegistry.getAdapter(existing.kind);
      if (!adapter) return c.json({ error: `kind "${existing.kind}" 未注册 adapter` }, 400);
      const validated = adapter.validateConfig(existing.type, body.config);
      if (!validated.ok) return c.json({ error: validated.error }, 400);
      configStr = validated.config;
    }

    const updated = marketSourceStore.update(id, {
      label:     body.label,
      enabled:   body.enabled,
      config:    configStr,
      sortOrder: body.sortOrder,
    });
    return c.json({ source: updated });
  });

  // ── Delete source ──────────────────────────────────────────────────────────
  router.delete('/sources/:id', (c) => {
    const id = c.req.param('id');
    const existing = marketSourceStore.get(id);
    if (!existing) return c.json({ error: '源不存在' }, 404);
    if (existing.builtin) {
      return c.json({ error: '内置源不可删除,可禁用' }, 400);
    }
    marketSourceStore.remove(id);
    return c.json({ ok: true });
  });

  // ── Test source connectivity ───────────────────────────────────────────────
  // 调 adapter.list 试拉,返回条目数 / error。用户加源前可先测。
  router.get('/sources/:id/test', async (c) => {
    const id = c.req.param('id');
    const source = marketSourceStore.get(id);
    if (!source) return c.json({ error: '源不存在' }, 404);

    const adapter = marketRegistry.getAdapter(source.kind);
    if (!adapter) return c.json({ error: `kind "${source.kind}" 未注册 adapter` }, 400);

    try {
      const entries = await adapter.list(source) as unknown[];
      return c.json({ ok: true, count: entries.length, sample: entries.slice(0, 3) });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
  });

  return router;
}
