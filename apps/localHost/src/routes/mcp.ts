// 这里提供 MCP server 配置管理、连接生命周期、探测与 Registry 目录源 API。
import { Hono }                from 'hono';
import { z }                   from 'zod';
import {
  McpInstallProvenanceSchema,
  McpServerConfigSchema,
  fetchRegistryEntries,
  fetchRegistryEntryLatest,
  installRegistryEntry,
  parseImportedMcpServers,
  resolveRegistryEntry,
} from '@ema-agent/mcp';
import type { McpRegistry, McpRegistrySourceStore } from '@ema-agent/mcp';

/** HTTP 管理面只做注册、连接生命周期和探测，不接触运行时工具调用。 */
type McpServerManagement = Pick<
  McpRegistry,
  | 'listRecords'
  | 'getAllConnections'
  | 'register'
  | 'findByName'
  | 'connectConfig'
  | 'getConnection'
  | 'setEnabled'
  | 'connect'
  | 'disconnect'
  | 'remove'
  | 'probe'
>;
type McpSourceManagement = Pick<
  McpRegistrySourceStore,
  'list' | 'listEnabled' | 'get' | 'add' | 'update' | 'remove'
>;

// ── MCP server management routes ──────────────────────────────────────────────
//
// GET    /api/mcp/servers                     list all registered servers + connection state
// POST   /api/mcp/servers                     register a new server
// GET    /api/mcp/servers/:name               single server info + tools
// PUT    /api/mcp/servers/:name/enable        enable server
// PUT    /api/mcp/servers/:name/disable       disable server
// POST   /api/mcp/servers/:name/connect       connect (or reconnect) now
// POST   /api/mcp/servers/:name/disconnect
// DELETE /api/mcp/servers/:name               remove from DB (and disconnect)
// POST   /api/mcp/servers/:name/check-update  registry 安装的版本更新检查
// POST   /api/mcp/import                      粘贴 JSON/裸 URL 导入
// POST   /api/mcp/probe                       test a config without saving
//
// ── Registry 目录源 ──
// GET    /api/mcp/registry-sources            源列表
// POST   /api/mcp/registry-sources            {label, registryUrl}
// PATCH  /api/mcp/registry-sources/:id        {label?, registryUrl?, enabled?}
// DELETE /api/mcp/registry-sources/:id        builtin 源拒删
// POST   /api/mcp/registry-sources/:id/test   拉第一页验证连通
// GET    /api/mcp/registry-entries            聚合全部启用源的可安装条目
// POST   /api/mcp/registry-install            {sourceId, entryName, name?, inputs?}

const registerSchema = z.object({
  name:      z.string().min(1).max(100),
  config:    McpServerConfigSchema,
  sourceUrl: z.string().url().optional(),
  provenance: McpInstallProvenanceSchema.optional(),
  // Market installs save the entry without connecting — many servers need env
  // vars / API keys / a local npx-uvx runtime before they can start.
  connect:   z.boolean().default(true),
});

const probeSchema = z.object({
  serverName: z.string().trim().min(1).max(100),
  config: McpServerConfigSchema,
});

const sourceAddSchema = z.object({
  label:       z.string().trim().min(1).max(100),
  registryUrl: z.string().url(),
});

const sourcePatchSchema = z.object({
  label:       z.string().trim().min(1).max(100).optional(),
  registryUrl: z.string().url().optional(),
  enabled:     z.boolean().optional(),
});

const installSchema = z.object({
  sourceId:  z.string().min(1),
  entryName: z.string().min(1),
  name:      z.string().trim().min(1).max(100).optional(),
  inputs:    z.record(z.string(), z.string()).optional(),
});

export function createMcpRouter(
  mcpRegistry: McpServerManagement,
  mcpSources: McpSourceManagement,
) {
  const router = new Hono();

  // ── Registry 目录源 ─────────────────────────────────────────────────────────

  router.get('/registry-sources', (c) => {
    return c.json({ sources: mcpSources.list() });
  });

  router.post('/registry-sources', async (c) => {
    let body: z.infer<typeof sourceAddSchema>;
    try {
      body = sourceAddSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
    return c.json({ source: mcpSources.add(body.label, body.registryUrl) }, 201);
  });

  router.patch('/registry-sources/:id', async (c) => {
    const id = c.req.param('id');
    if (!mcpSources.get(id)) return c.json({ error: 'Source not found' }, 404);
    let body: z.infer<typeof sourcePatchSchema>;
    try {
      body = sourcePatchSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
    mcpSources.update(id, body);
    return c.json({ source: mcpSources.get(id) });
  });

  router.delete('/registry-sources/:id', (c) => {
    // builtin(官方源)拒删;删除不影响已安装 server(溯源悬空,UI 提示)。
    if (!mcpSources.remove(c.req.param('id'))) {
      return c.json({ error: 'Source not found or is builtin' }, 404);
    }
    return c.json({ ok: true });
  });

  router.post('/registry-sources/:id/test', async (c) => {
    const source = mcpSources.get(c.req.param('id'));
    if (!source) return c.json({ error: 'Source not found' }, 404);
    try {
      const result = await fetchRegistryEntries(source.registryUrl, {
        signal: c.req.raw.signal,
        maxPages: 1,
      });
      return c.json({ ok: true, sampleCount: result.entries.length, skipped: result.skipped });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 502);
    }
  });

  // ── 浏览:聚合全部启用源;单源失败降级为该源的 error,不拖垮其他源。 ─────────────
  router.get('/registry-entries', async (c) => {
    const sources = mcpSources.listEnabled();
    const results = await Promise.all(sources.map(async (source) => {
      try {
        const result = await fetchRegistryEntries(source.registryUrl, {
          signal: c.req.raw.signal,
        });
        return {
          sourceId: source.id,
          label: source.label,
          entries: result.entries.map(resolveRegistryEntry),
          skipped: result.skipped,
          truncated: result.truncated,
        };
      } catch (err) {
        return {
          sourceId: source.id,
          label: source.label,
          entries: [],
          skipped: 0,
          truncated: false,
          error: (err as Error).message,
        };
      }
    }));
    return c.json({
      sources: results.map(({ entries, ...rest }) => ({ ...rest, count: entries.length })),
      entries: results.flatMap((result) =>
        result.entries.map((entry) => ({ ...entry, registrySourceId: result.sourceId }))),
    });
  });

  // ── 安装:始终从源现场取该条目最新版本再解析,不用浏览缓存。 ─────────────────────
  router.post('/registry-install', async (c) => {
    let body: z.infer<typeof installSchema>;
    try {
      body = installSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
    const source = mcpSources.get(body.sourceId);
    if (!source) return c.json({ error: 'Source not found' }, 404);

    let raw;
    try {
      raw = await fetchRegistryEntryLatest(source.registryUrl, body.entryName, {
        signal: c.req.raw.signal,
      });
    } catch (err) {
      return c.json({ error: `Registry 拉取失败: ${(err as Error).message}` }, 502);
    }
    if (!raw) return c.json({ error: `条目 ${body.entryName} 在该源不存在或版本不可用` }, 404);

    const entry = resolveRegistryEntry(raw);
    try {
      const id = installRegistryEntry({
        store: mcpRegistry,
        source,
        entry,
        name: body.name,
        inputs: body.inputs,
      });
      return c.json({ id, entry: { name: entry.name, version: entry.version } }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 422);
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

    const id = mcpRegistry.register(body.name, body.config, body.sourceUrl, body.provenance);

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

  // ── Import (粘贴 mcp.so / Claude Desktop / ModelScope JSON 或裸 URL) ─────────
  // Accepts { json: "<pasted config text or object>" }. Parses the common
  // shapes (mcpServers map / single server / bare map / bare URL), infers
  // transport type, registers each, and best-effort connects.
  router.post('/import', async (c) => {
    let payload: unknown;
    try {
      const body = await c.req.json() as { json?: unknown };
      if (typeof body.json === 'string') {
        const text = body.json.trim();
        // 裸 URL 字符串直接交给解析器;JSON 文本先 parse
        payload = text.startsWith('{') ? JSON.parse(text) : text;
      } else {
        payload = body.json;
      }
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
        const id = mcpRegistry.register(
          name,
          config,
          undefined,
          { sourceKind: 'import' },
        );
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

  // ── 更新检查:registry 安装的 server 对照源内最新版本。 ─────────────────────────
  router.post('/servers/:name/check-update', async (c) => {
    const name = c.req.param('name');
    const record = mcpRegistry.findByName(name);
    if (!record) return c.json({ error: 'Server not found' }, 404);
    if (record.provenance.sourceKind !== 'registry') {
      return c.json({ updateAvailable: false, reason: 'not_a_registry_install' });
    }
    const source = mcpSources.get(record.provenance.registrySourceId);
    if (!source) {
      return c.json({ updateAvailable: false, reason: 'source_deleted' });
    }
    const latest = await fetchRegistryEntryLatest(
      source.registryUrl,
      record.provenance.registryEntryId,
      { signal: c.req.raw.signal },
    );
    if (!latest) {
      return c.json({ updateAvailable: false, reason: 'entry_unavailable' });
    }
    return c.json({
      updateAvailable: latest.version !== record.provenance.registryVersion,
      installedVersion: record.provenance.registryVersion,
      latestVersion: latest.version,
    });
  });

  // ── Probe (test without saving) ───────────────────────────────────────────
  router.post('/probe', async (c) => {
    let body: z.infer<typeof probeSchema>;
    try {
      body = probeSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
    const result = await mcpRegistry.probe(body.serverName, body.config, c.req.raw.signal);
    return c.json(result, result.ok ? 200 : 500);
  });

  return router;
}
