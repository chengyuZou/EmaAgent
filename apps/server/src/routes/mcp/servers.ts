import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  McpAuthTypeSchema,
  McpInstallProvenanceSchema,
  McpServerConfigSchema,
  McpServerConflictError,
  McpServerNameSchema,
  McpServerNotFoundError,
  McpUnsupportedTransportError,
  parseImportedMcpServers,
  type McpServerManager,
} from '@ema-agent/mcp';
import { jsonBody } from '../validate.js';

export interface McpServersRouteDeps {
  readonly mcp: Pick<McpServerManager,
    'listServers' | 'getServer' | 'create' | 'update'
    | 'setEnabled' | 'connect' | 'disconnect' | 'remove' | 'probe'
    | 'startOAuth' | 'cancelOAuth' | 'clearOAuthTokens'>;
}

const createBody = z.object({
  name: McpServerNameSchema,
  config: McpServerConfigSchema,
  provenance: McpInstallProvenanceSchema.optional(),
  authType: McpAuthTypeSchema.optional(),
});
const updateBody = z.object({
  config: McpServerConfigSchema,
  provenance: McpInstallProvenanceSchema.optional(),
  authType: McpAuthTypeSchema.optional(),
});
const probeBody = z.object({
  serverName: z.string().trim().min(1).max(100),
  config: McpServerConfigSchema,
});
const importBody = z.object({ json: z.unknown() });

export const mcpServersRoute = (deps: McpServersRouteDeps) => new Hono()
  .get('/servers', context => {
    return context.json({ items: deps.mcp.listServers() });
  })
  .post('/servers', jsonBody(createBody), async context => {
    const body = context.req.valid('json');
    return runMcpAction(context, async () =>
      context.json({ id: await deps.mcp.create(body.name, body.config, body.provenance, body.authType) }, 201),
    );
  })
  .put('/servers/:name', jsonBody(updateBody), async context => {
    const body = context.req.valid('json');
    return runMcpAction(context, async () => {
      await deps.mcp.update(context.req.param('name'), body.config, body.provenance, body.authType);
      return context.json({ ok: true });
    });
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
        return { name, id: await deps.mcp.create(name, config, { sourceKind: 'import' }), ok: true as const };
      } catch (error) {
        return { name, ok: false as const, error: messageOf(error) };
      }
    }));
    return context.json({ items }, 201);
  })
  .get('/servers/:name', context => {
    const server = deps.mcp.getServer(context.req.param('name'));
    return server
      ? context.json(server)
      : context.json({ error: 'server_not_found' }, 404);
  })
  .put('/servers/:name/enable', async context => {
    return runMcpAction(context, async () => {
      await deps.mcp.setEnabled(context.req.param('name'), true);
      return context.json({ ok: true });
    });
  })
  .put('/servers/:name/disable', async context => {
    return runMcpAction(context, async () => {
      await deps.mcp.setEnabled(context.req.param('name'), false);
      return context.json({ ok: true });
    });
  })
  .post('/servers/:name/connect', context => {
    const name = context.req.param('name');
    const server = deps.mcp.getServer(name);
    if (!server) {
      return context.json({ error: 'server_not_found', message: `MCP server "${name}" not found.` }, 404);
    }
    if (!server.enabled) {
      return context.json({ error: 'server_disabled', message: `MCP server "${name}" is disabled.` }, 400);
    }
    // 发起连接请求即返回, 实际状态与失败详情通过 mcp_connection_changed 事件推送并记录到 connectionError.
    void deps.mcp.connect(name).catch(() => undefined);
    return context.json({ ok: true });
  })
  .post('/servers/:name/disconnect', async context => {
    return runMcpAction(context, async () => {
      await deps.mcp.disconnect(context.req.param('name'));
      return context.json({ ok: true });
    });
  })
  .delete('/servers/:name', async context => {
    return runMcpAction(context, async () => {
      await deps.mcp.remove(context.req.param('name'));
      return context.json({ ok: true });
    });
  })
  .post('/servers/:name/oauth/start', async context => {
    return runMcpAction(context, async () =>
      context.json(await deps.mcp.startOAuth(context.req.param('name'))),
    );
  })
  .post('/servers/:name/oauth/cancel', async context => {
    return runMcpAction(context, async () => {
      await deps.mcp.cancelOAuth(context.req.param('name'));
      return context.json({ ok: true });
    });
  })
  .delete('/servers/:name/oauth/tokens', async context => {
    return runMcpAction(context, async () => {
      await deps.mcp.clearOAuthTokens(context.req.param('name'));
      return context.json({ ok: true });
    });
  })
  .post('/probe', jsonBody(probeBody), async context => {
    const body = context.req.valid('json');
    return context.json(await deps.mcp.probe(body.serverName, body.config, context.req.raw.signal));
  });

async function runMcpAction<T>(context: Context, action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    const mapped = mcpError(context, error);
    if (mapped) return mapped;
    throw error;
  }
}

function mcpError(context: Context, error: unknown) {
  if (error instanceof McpServerNotFoundError) {
    return context.json({ error: 'server_not_found' as const, message: error.message }, 404);
  }
  if (error instanceof McpServerConflictError) {
    return context.json({ error: 'server_conflict' as const, message: error.message }, 409);
  }
  if (error instanceof McpUnsupportedTransportError) {
    return context.json({ error: 'unsupported_transport' as const, message: error.message }, 400);
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
