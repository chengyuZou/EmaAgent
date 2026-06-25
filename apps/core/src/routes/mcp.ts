import { Hono }                from 'hono';
import { z }                   from 'zod';
import { McpServerConfigSchema, parseImportedMcpServers } from '@ema-agent/mcp';
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
  // Market installs save the entry without connecting — many servers need env
  // vars / API keys / a local npx-uvx runtime before they can start.
  connect:   z.boolean().default(true),
});

// ── Marketplace (official MCP registry) ──────────────────────────────────────
//
// mcp.so has no public JSON API (403s on scraping). The official registry at
// registry.modelcontextprotocol.io exposes a documented REST endpoint, so we
// browse that and normalise entries into install-ready configs for the UI.

const MCP_REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0/servers';
const MCP_MARKET_CAP    = 600;  // safety cap on total entries fetched
const MCP_MARKET_PAGES  = 12;   // safety cap on cursor follow-ups

interface McpMarketEntry {
  name:         string;
  title?:       string;
  description?: string;
  version?:     string;
  repository?:  string;
  websiteUrl?:  string;
  transport:    'stdio' | 'sse' | 'http' | null;
  url?:         string;
  command?:     string;
  args?:        string[];
}

// The registry uses snake_case and (in newer revisions) has renamed some keys,
// so accept both spellings defensively.
interface RegistryPackage {
  registry_type?: string;   // "npm" | "pypi" | "oci" …
  registry_name?: string;   // older field name for registry_type
  identifier?:    string;
  name?:          string;   // some entries put the package id here
  version?:       string;
  runtime_hint?:  string;
  transport?:     { type?: string };
}
interface RegistryRemote { type?: string; url?: string }
interface RegistryServer {
  name:         string;
  title?:       string;
  description?: string;
  version?:     string;
  websiteUrl?:  string;
  repository?:  { url?: string };
  remotes?:     RegistryRemote[];
  packages?:    RegistryPackage[];
}
// Each list item wraps the server under `server`, with registry metadata in `_meta`.
interface RegistryItem { server?: RegistryServer }

function normaliseRegistryServer(s: RegistryServer): McpMarketEntry {
  const base: McpMarketEntry = {
    name:        s.name,
    title:       s.title,
    description: s.description,
    version:     s.version,
    repository:  s.repository?.url,
    websiteUrl:  s.websiteUrl,
    transport:   null,
  };

  // Prefer a hosted remote (no local install needed).
  const remote = s.remotes?.find((r) => r.url);
  if (remote?.url) {
    return { ...base, transport: remote.type === 'sse' ? 'sse' : 'http', url: remote.url };
  }

  // Otherwise derive a stdio launch command from the first package.
  const pkg = s.packages?.find((p) => p.identifier || p.name);
  const pkgId = pkg?.identifier ?? pkg?.name;
  if (pkg && pkgId) {
    const kind = pkg.registry_type ?? pkg.registry_name;
    if (kind === 'npm') {
      return { ...base, transport: 'stdio', command: 'npx', args: ['-y', pkgId] };
    }
    if (kind === 'pypi') {
      return { ...base, transport: 'stdio', command: 'uvx', args: [pkgId] };
    }
  }
  return base;
}

export function createMcpRouter(bindings: AppBindings) {
  const router = new Hono();
  const { mcpRegistry } = bindings;

  // ── Marketplace ─────────────────────────────────────────────────────────────
  // The registry is cursor-paginated (no total count), so we follow nextCursor
  // and return the whole catalog — the UI paginates client-side (numbered pages
  // + jump). Versions are deduped by name, keeping the newest seen.
  router.get('/market', async (c) => {
    try {
      const all  = new Map<string, McpMarketEntry>();
      let cursor: string | undefined;

      for (let page = 0; page < MCP_MARKET_PAGES && all.size < MCP_MARKET_CAP; page++) {
        const url = new URL(MCP_REGISTRY_BASE);
        url.searchParams.set('limit', '100');
        if (cursor) url.searchParams.set('cursor', cursor);

        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal:  AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          if (all.size > 0) break;  // partial result is still useful
          return c.json({ error: `registry HTTP ${res.status}`, servers: [] }, 502);
        }

        const body = await res.json() as {
          servers?:  Array<RegistryItem | RegistryServer>;
          metadata?: { nextCursor?: string };
        };
        for (const item of body.servers ?? []) {
          const s = 'server' in item && item.server ? item.server : (item as RegistryServer);
          if (!s || typeof s.name !== 'string') continue;
          const entry = normaliseRegistryServer(s);
          if (entry.transport === null) continue;
          all.set(entry.name, entry);  // later (newer) version overwrites
        }

        cursor = body.metadata?.nextCursor;
        if (!cursor) break;
      }

      return c.json({ source: 'registry.modelcontextprotocol.io', servers: [...all.values()] });
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
