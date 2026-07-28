// 提供记忆面板浏览、会话覆盖和维护任务的 HTTP 边界。
import { Hono } from 'hono';
import { z } from 'zod';
import { asSessionId } from '@ema-agent/ids';
import type { MemoryPlanner } from '@ema-agent/memory';

/** 记忆面板实际使用的查询与维护入口，不暴露提取、召回等 Turn 侧能力。 */
type MemoryPanelRoute = Pick<
  MemoryPlanner,
  | 'getStats'
  | 'listNodes'
  | 'listItems'
  | 'listEdgesForNodes'
  | 'getSessionOverrides'
  | 'setSessionOverrides'
  | 'deleteNode'
  | 'deleteItem'
  | 'runMaintenance'
>;

// ── Schemas ──────────────────────────────────────────────────────────────────

const nodeTypeSchema = z.enum([
  'user_fact', 'entity', 'event', 'emotion', 'preference', 'relationship',
]);

const itemKindSchema = z.enum(['user', 'feedback', 'project', 'reference']);

const browseNodesQuery = z.object({
  limit:         z.coerce.number().int().min(1).max(500).default(100),
  nodeType:      nodeTypeSchema.optional(),
  minImportance: z.coerce.number().int().min(0).max(100).optional(),
  orderBy:       z.enum(['lastRef', 'importance', 'created']).default('lastRef'),
  search:        z.string().optional(),
});

const browseItemsQuery = z.object({
  limit:         z.coerce.number().int().min(1).max(500).default(100),
  kind:          itemKindSchema.optional(),
  mode:          z.enum(['chat', 'narrative', 'agent']).optional(),
  minImportance: z.coerce.number().int().min(0).max(100).optional(),
  orderBy:       z.enum(['lastRef', 'importance', 'created']).default('lastRef'),
  search:        z.string().optional(),
});

const overridesSchema = z.object({
  layer0:        z.boolean().optional(),
  layer1:        z.boolean().optional(),
  layer2:        z.boolean().optional(),
  extraction:    z.boolean().optional(),
  consolidation: z.boolean().optional(),
});

const maintenanceSchema = z.object({
  decayAfterDays:     z.number().int().min(1).max(365).default(30),
  // importance is a 0–100 score, so decayAmount is points subtracted per pass.
  decayAmount:        z.number().min(0).max(100).default(10),
  decayItems:         z.boolean().default(true),
  dryRun:             z.boolean().default(true),
});

// ── Route factory ────────────────────────────────────────────────────────────

/**
 * Memory inspection + maintenance routes for the frontend memory panel.
 *
 * Read:
 *   GET  /api/memory/stats                — aggregate counts + index status
 *   GET  /api/memory/nodes                — browse memory_nodes
 *   GET  /api/memory/items                — browse memory_items
 *   GET  /api/memory/sessions/:id/overrides
 *
 * Write:
 *   PUT  /api/memory/sessions/:id/overrides — partial overrides update
 *   DEL  /api/memory/nodes/:id             — user-initiated hard delete
 *   DEL  /api/memory/items/:id
 *   POST /api/memory/maintenance           — decay pass (dryRun=true by default)
 */
export function memoryRoute(memory: MemoryPanelRoute): Hono {
  const app = new Hono();

  // ── Stats ─────────────────────────────────────────────────────────────────
  app.get('/stats', (c) => {
    return c.json(memory.getStats());
  });

  // ── Browse nodes ──────────────────────────────────────────────────────────
  app.get('/nodes', (c) => {
    const parsed = browseNodesQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const rows = memory.listNodes(parsed.data);
    return c.json(rows);
  });

  // ── Browse items ──────────────────────────────────────────────────────────
  app.get('/items', (c) => {
    const parsed = browseItemsQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const rows = memory.listItems(parsed.data);
    return c.json(rows);
  });

  // ── Edges (for a set of node ids, graph rendering) ────────────────────────
  app.get('/edges', (c) => {
    const ids = (c.req.query('nodes') ?? '').split(',').filter(Boolean);
    if (ids.length === 0) return c.json([]);
    return c.json(memory.listEdgesForNodes(ids));
  });

  // ── Per-session overrides ─────────────────────────────────────────────────
  app.get('/sessions/:id/overrides', (c) => {
    const sid = asSessionId(c.req.param('id'));
    return c.json(memory.getSessionOverrides(sid));
  });

  app.put('/sessions/:id/overrides', async (c) => {
    const sid = asSessionId(c.req.param('id'));
    const parsed = overridesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    memory.setSessionOverrides(sid, parsed.data);
    return c.json(memory.getSessionOverrides(sid));
  });

  // ── Delete nodes / items (user-initiated) ─────────────────────────────────
  app.delete('/nodes/:id', (c) => {
    memory.deleteNode(c.req.param('id'));
    return c.body(null, 204);
  });

  app.delete('/items/:id', (c) => {
    memory.deleteItem(c.req.param('id'));
    return c.body(null, 204);
  });

  // ── Maintenance: importance decay ─────────────────────────────────────────
  app.post('/maintenance', async (c) => {
    const parsed = maintenanceSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const report = memory.runMaintenance(parsed.data);
    return c.json(report);
  });

  return app;
}
