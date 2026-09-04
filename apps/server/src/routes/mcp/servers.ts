import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  McpInstallProvenanceSchema,
  McpServerConfigSchema,
  McpServerNotFoundError,
  McpUnsupportedTransportError,
  parseImportedMcpServers,
  type McpRegistry,
} from '@ema-agent/mcp';
import { jsonBody } from '../validate.js';

export interface McpServersRouteDeps {
  readonly mcp: Pick<McpRegistry,
    'listRecords' | 'getAllConnections' | 'save' | 'findByName' | 'getConnection'
    | 'setEnabled' | 'connectInBackground' | 'disconnect' | 'remove' | 'probe'>;
}

const saveBody = z.object({
  name: z.string().trim().min(1).max(100),
  config: McpServerConfigSchema,
  provenance: McpInstallProvenanceSchema.optional(),
});
const probeBody = z.object({
  serverName: z.string().trim().min(1).max(100),
  config: McpServerConfigSchema,
});
const importBody = z.object({ json: z.unknown() });

export const mcpServersRoute = (deps: McpServersRouteDeps) => new Hono()
  .get('/servers', context => {
    const connections = new Map(
      deps.mcp.getAllConnections().map(connection => [connection.serverName, connection] as const),
    );
    return context.json({ items: deps.mcp.listRecords().map(record => ({
      ...record,
      connection: connections.get(record.name)
        ?? { serverName: record.name, status: 'disconnected' as const, tools: [] },
    })) });
  })
  .post('/servers', jsonBody(saveBody), async context => {
    const body = context.req.valid('json');
    try {
      return context.json({ id: await deps.mcp.save(body.name, body.config, body.provenance) }, 201);
    } catch (error) {
      const mapped = mcpError(context, error);
      if (mapped) return mapped;
      throw error;
    }
  })
  .post('/import', jsonBody(importBody), async context => {
    const payload = context.req.valid('json').json;
    let parsed: unknown = payload;
    if (typeof payload === 'string') {
      try { parsed = JSON.parse(payload); }
      catch (error) { return context.json({ error: 'invalid_json', message: messageOf(error) }, 400); }
    }
    let servers;
    try { servers = parseImportedMcpServers(parsed); }
    catch (error) { return context.json({ error: 'invalid_import', message: messageOf(error) }, 400); }
    const items = await Promise.all(servers.map(async ({ name, config }) => {
      try {
        return { name, id: await deps.mcp.save(name, config, { sourceKind: 'import' }), ok: true as const };
      } catch (error) {
        return { name, ok: false as const, error: messageOf(error) };
      }
    }));
    return context.json({ items }, 201);
  })
  .get('/servers/:name', context => {
    const record = deps.mcp.findByName(context.req.param('name'));
    if (!record) return context.json({ error: 'server_not_found' }, 404);
    return context.json({ ...record, connection: deps.mcp.getConnection(record.name)
      ?? { serverName: record.name, status: 'disconnected' as const, tools: [] } });
  })
  .put('/servers/:name/enable', context => {
    deps.mcp.setEnabled(context.req.param('name'), true);
    return context.json({ ok: true });
  })
  .put('/servers/:name/disable', async context => {
    await deps.mcp.setEnabled(context.req.param('name'), false);
    return context.json({ ok: true });
  })
  .post('/servers/:name/connect', context => {
    deps.mcp.connectInBackground(context.req.param('name'));
    return context.json({ ok: true });
  })
  .post('/servers/:name/disconnect', async context => {
    await deps.mcp.disconnect(context.req.param('name'));
    return context.json({ ok: true });
  })
  .delete('/servers/:name', async context => {
    await deps.mcp.remove(context.req.param('name'));
    return context.json({ ok: true });
  })
  .post('/probe', jsonBody(probeBody), async context => {
    const body = context.req.valid('json');
    return context.json(await deps.mcp.probe(body.serverName, body.config, context.req.raw.signal));
  });

function mcpError(context: Context, error: unknown) {
  if (error instanceof McpServerNotFoundError) {
    return context.json({ error: 'server_not_found', message: error.message }, 404);
  }
  if (error instanceof McpUnsupportedTransportError) {
    return context.json({ error: 'unsupported_transport', message: error.message }, 400);
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
