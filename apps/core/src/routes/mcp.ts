import { Hono }                from 'hono';
import { z }                   from 'zod';
import { McpServerConfigSchema } from '@ema-agent/mcp';
import type { AppBindings }    from '../wiring.js';

// ── MCP server management routes ──────────────────────────────────────────────
//
// GET  /api/mcp/servers                list all registered servers + connection state
// POST /api/mcp/servers                register a new server
// GET  /api/mcp/servers/:name          single server info + tools
// PUT  /api/mcp/servers/:name/enable   enable server
// PUT  /api/mcp/servers/:name/disable  disable server
// POST /api/mcp/servers/:name/connect  connect (or reconnect) now
// POST /api/mcp/servers/:name/disconnect
// DELETE /api/mcp/servers/:name        remove from DB (and disconnect)
// POST /api/mcp/probe                  test a config without saving

const registerSchema = z.object({
  name:      z.string().min(1).max(100),
  config:    McpServerConfigSchema,
  sourceUrl: z.string().url().optional(),
});

export function createMcpRouter(bindings: AppBindings) {
  const router = new Hono();
  const { mcpRegistry } = bindings;

  // ── List ──────────────────────────────────────────────────────────────────
  router.get('/servers', (c) => {
    const records     = mcpRegistry.listRecords();
    const connections = mcpRegistry.getAllConnections();
    const connMap     = new Map(connections.map((conn) => [conn.serverName, conn]));

    return c.json({
      servers: records.map((r) => ({
        ...r,
        connection: connMap.get(r.name) ?? { serverName: r.name, status: 'disconnected', tools: [] },
      })),
    });
  });

  // ── Register ──────────────────────────────────────────────────────────────
  router.post('/servers', async (c) => {
    let body: z.infer<typeof registerSchema>;
    try {
      body = registerSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    const id = mcpRegistry.register(body.name, body.config, body.sourceUrl);

    // Auto-connect after registration
    try {
      const conn = await mcpRegistry.connectConfig(body.name, body.config);
      return c.json({ id, connection: conn }, 201);
    } catch (err) {
      return c.json({ id, error: `Registered but connection failed: ${(err as Error).message}` }, 201);
    }
  });

  // ── Single server ─────────────────────────────────────────────────────────
  router.get('/servers/:name', (c) => {
    const name    = c.req.param('name');
    const records = mcpRegistry.listRecords();
    const record  = records.find((r) => r.name === name);
    if (!record) return c.json({ error: 'Server not found' }, 404);

    const conn = mcpRegistry.getConnection(name);
    return c.json({ ...record, connection: conn ?? { serverName: name, status: 'disconnected', tools: [] } });
  });

  // ── Enable / disable ──────────────────────────────────────────────────────
  router.put('/servers/:name/enable', (c) => {
    try {
      mcpRegistry.setEnabled(c.req.param('name'), true);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  router.put('/servers/:name/disable', async (c) => {
    const name = c.req.param('name');
    try {
      mcpRegistry.setEnabled(name, false);
      await mcpRegistry.disconnect(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  // ── Connect / disconnect ──────────────────────────────────────────────────
  router.post('/servers/:name/connect', async (c) => {
    try {
      const conn = await mcpRegistry.connect(c.req.param('name'));
      return c.json({ connection: conn });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  router.post('/servers/:name/disconnect', async (c) => {
    await mcpRegistry.disconnect(c.req.param('name'));
    return c.json({ ok: true });
  });

  // ── Remove ────────────────────────────────────────────────────────────────
  router.delete('/servers/:name', async (c) => {
    await mcpRegistry.disconnect(c.req.param('name'));
    mcpRegistry.remove(c.req.param('name'));
    return c.json({ ok: true });
  });

  // ── Probe (test without saving) ───────────────────────────────────────────
  router.post('/probe', async (c) => {
    let config: z.infer<typeof McpServerConfigSchema>;
    try {
      config = McpServerConfigSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
    const result = await mcpRegistry.probe(config);
    return c.json(result, result.ok ? 200 : 500);
  });

  return router;
}
