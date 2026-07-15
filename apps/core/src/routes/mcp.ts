import { Hono }                from 'hono';
import { z }                   from 'zod';
import { McpServerConfigSchema, parseImportedMcpServers } from '@ema-agent/mcp';
import { mergeByName }         from '@ema-agent/marketplace';
import type { McpMarketEntry } from '@ema-agent/mcp';
import type { AppBindings }    from '../wiring/index.js';

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
  // Market installs save the entry without connecting — many servers need env
  // vars / API keys / a local npx-uvx runtime before they can start.
  connect:   z.boolean().default(true),
});

const probeSchema = z.object({
  serverName: z.string().trim().min(1).max(100),
  config: McpServerConfigSchema,
});

// ── Marketplace ──────────────────────────────────────────────────────────────
//
// 市场源从 market_sources 表读(marketplace 底座),聚合所有 enabled 源并发 fetch。
// 单源失败不阻断。源管理走 /api/market/sources。
// 旧的 inline registry fetch + normaliseRegistryServer 已搬到
// packages/mcp/src/market/adapters/mcp-registry.ts。

export function createMcpRouter(bindings: AppBindings) {
  const router = new Hono();
  const { mcpRegistry } = bindings;

  // ── Marketplace ─────────────────────────────────────────────────────────────
  router.get('/market', async (c) => {
    try {
      const sources = bindings.marketSourceStore.listEnabled('mcp');
      const results = await bindings.marketRegistry.listAll<McpMarketEntry>('mcp', sources);
      // 跨源按 name 去重,sortOrder 小的优先(底座 mergeByName 保策略一致)
      const servers = mergeByName(results);
      return c.json({
        sources: results.map((r) => ({ id: r.sourceId, label: r.sourceLabel, type: r.sourceType, error: r.error, count: r.entries.length })),
        servers,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message, servers: [] }, 502);
    }
  });

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

    if (!body.connect) {
      // Saved as a disconnected candidate — user connects after filling env/keys.
      return c.json({ id, connection: { serverName: body.name, status: 'disconnected', tools: [] } }, 201);
    }

    // Auto-connect after registration
    try {
      const conn = await mcpRegistry.connectConfig(body.name, body.config);
      return c.json({ id, connection: conn }, 201);
    } catch (err) {
      return c.json({ id, error: `Registered but connection failed: ${(err as Error).message}` }, 201);
    }
  });

  // ── Import (paste mcp.so / Claude Desktop JSON) ─────────────────────────────
  // Accepts { json: "<pasted config text or object>" }. Parses the common
  // shapes (mcpServers map / single server / bare map), infers transport type,
  // registers each, and best-effort connects. Returns per-server results.
  router.post('/import', async (c) => {
    let payload: unknown;
    try {
      const body = await c.req.json() as { json?: unknown };
      payload = typeof body.json === 'string' ? JSON.parse(body.json) : body.json;
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }

    let servers;
    try {
      servers = parseImportedMcpServers(payload);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    const results = [];
    for (const { name, config } of servers) {
      try {
        const id = mcpRegistry.register(name, config);
        try {
          await mcpRegistry.connectConfig(name, config);
          results.push({ name, id, ok: true });
        } catch (err) {
          results.push({ name, id, ok: true, connectError: (err as Error).message });
        }
      } catch (err) {
        results.push({ name, ok: false, error: (err as Error).message });
      }
    }
    return c.json({ imported: results }, 201);
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
    let body: z.infer<typeof probeSchema>;
    try {
      body = probeSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
    const result = await mcpRegistry.probe(body.serverName, body.config);
    return c.json(result, result.ok ? 200 : 500);
  });

  return router;
}
