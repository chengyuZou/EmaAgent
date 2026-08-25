// MCP server 管理面：注册、启停、连接生命周期、粘贴导入、更新检查与免存探测。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  McpInstallProvenanceSchema,
  McpServerConfigSchema,
  McpServerNotFoundError,
  McpStdioPermissionError,
  McpUnsupportedTransportError,
  fetchRegistryEntryLatest,
  parseImportedMcpServers,
  type McpRegistry,
  type McpRegistrySourceStore,
} from '@ema-agent/mcp';
import { jsonBody } from '../validate.js';

export interface McpServersRouteDeps {
  readonly mcp: Pick<
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
  readonly mcpSources: Pick<McpRegistrySourceStore, 'get'>;
}

const registerBody = z.object({
  name: z.string().min(1).max(100),
  config: McpServerConfigSchema,
  sourceUrl: z.url().optional(),
  provenance: McpInstallProvenanceSchema.optional(),
  /** 缺省注册即连；false 只存配置（待补 env/key 后再手动连接）。 */
  connect: z.boolean().optional(),
});

const probeBody = z.object({
  serverName: z.string().trim().min(1).max(100),
  config: McpServerConfigSchema,
});

const importBody = z.object({
  /** 粘贴的 JSON 文本/对象，或裸 URL 字符串。 */
  json: z.unknown(),
});

export const mcpServersRoute = (deps: McpServersRouteDeps) =>
  new Hono()
    .get('/servers', context => {
      const connections = new Map(
        deps.mcp.getAllConnections().map(connection => [connection.serverName, connection] as const),
      );
      return context.json({
        items: deps.mcp.listRecords().map(record => ({
          ...record,
          connection: connections.get(record.name)
            ?? { serverName: record.name, status: 'disconnected', tools: [] },
        })),
      });
    })
    .post('/servers', jsonBody(registerBody), async context => {
      const { name, config, connect = true, sourceUrl, provenance } = context.req.valid('json');
      try {
        const id = deps.mcp.register(name, config, sourceUrl, provenance);
        if (!connect) {
          return context.json({
            id,
            connection: { serverName: name, status: 'disconnected', tools: [] },
          }, 201);
        }
        try {
          const connection = await deps.mcp.connectConfig(name, config);
          return context.json({ id, connection }, 201);
        } catch (error) {
          // 注册成功但首连失败：如实返回 201 + 错误，记录已落库可稍后再连。
          return context.json({ id, connectError: errorMessage(error) }, 201);
        }
      } catch (error) {
        const mapped = mcpError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    // 粘贴导入：mcpServers map / 单 server / 裸 map / 裸 URL 统一进解析器。
    .post('/import', jsonBody(importBody), async context => {
      let payload: unknown = context.req.valid('json').json;
      if (typeof payload === 'string') {
        const text = payload.trim();
        if (text.startsWith('{')) {
          try {
            payload = JSON.parse(text);
          } catch (error) {
            return context.json({ error: 'invalid_json', message: errorMessage(error) }, 400);
          }
        } else {
          payload = text;
        }
      }
      let servers;
      try {
        servers = parseImportedMcpServers(payload);
      } catch (error) {
        return context.json({ error: 'invalid_import', message: errorMessage(error) }, 400);
      }
      const results = [];
      for (const { name, config } of servers) {
        try {
          const id = deps.mcp.register(name, config, undefined, { sourceKind: 'import' });
          try {
            await deps.mcp.connectConfig(name, config);
            results.push({ name, id, ok: true as const });
          } catch (error) {
            results.push({ name, id, ok: true as const, connectError: errorMessage(error) });
          }
        } catch (error) {
          results.push({ name, ok: false as const, error: errorMessage(error) });
        }
      }
      return context.json({ items: results }, 201);
    })
    .get('/servers/:name', context => {
      const record = deps.mcp.findByName(context.req.param('name'));
      if (!record) return context.json({ error: 'server_not_found' }, 404);
      const connection = deps.mcp.getConnection(record.name)
        ?? { serverName: record.name, status: 'disconnected', tools: [] };
      return context.json({ ...record, connection });
    })
    .put('/servers/:name/enable', async context => {
      try {
        await deps.mcp.setEnabled(context.req.param('name'), true);
        return context.json({ ok: true });
      } catch (error) {
        const mapped = mcpError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .put('/servers/:name/disable', async context => {
      try {
        await deps.mcp.setEnabled(context.req.param('name'), false);
        return context.json({ ok: true });
      } catch (error) {
        const mapped = mcpError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .post('/servers/:name/connect', async context => {
      try {
        return context.json({ connection: await deps.mcp.connect(context.req.param('name')) });
      } catch (error) {
        const mapped = mcpError(context, error);
        if (mapped) return mapped;
        throw error;
      }
    })
    .post('/servers/:name/disconnect', async context => {
      await deps.mcp.disconnect(context.req.param('name'));
      return context.json({ ok: true });
    })
    .delete('/servers/:name', async context => {
      await deps.mcp.remove(context.req.param('name'));
      return context.json({ ok: true });
    })
    // registry 安装的更新检查：对照源内最新版本；非 registry 安装如实回答不可查。
    .post('/servers/:name/check-update', async context => {
      const record = deps.mcp.findByName(context.req.param('name'));
      if (!record) return context.json({ error: 'server_not_found' }, 404);
      if (record.provenance.sourceKind !== 'registry') {
        return context.json({ updateAvailable: false, reason: 'not_a_registry_install' });
      }
      const source = deps.mcpSources.get(record.provenance.registrySourceId);
      if (!source) {
        return context.json({ updateAvailable: false, reason: 'source_deleted' });
      }
      const latest = await fetchRegistryEntryLatest(
        source.registryUrl,
        record.provenance.registryEntryId,
        { signal: context.req.raw.signal },
      );
      if (!latest) {
        return context.json({ updateAvailable: false, reason: 'entry_unavailable' });
      }
      return context.json({
        updateAvailable: latest.version !== record.provenance.registryVersion,
        installedVersion: record.provenance.registryVersion,
        latestVersion: latest.version,
      });
    })
    // 免存探测：连不上是正常结论（ok:false），状态码恒 200。
    .post('/probe', jsonBody(probeBody), async context => {
      const { serverName, config } = context.req.valid('json');
      const result = await deps.mcp.probe(
        serverName,
        config,
        context.req.raw.signal,
      );
      return context.json(result);
    });

function mcpError(context: Context, error: unknown): Response | undefined {
  if (error instanceof McpServerNotFoundError) {
    return context.json({ error: 'server_not_found', message: error.message }, 404);
  }
  if (error instanceof McpStdioPermissionError) {
    return context.json({ error: 'stdio_launch_denied', message: error.message }, 403);
  }
  if (error instanceof McpUnsupportedTransportError) {
    return context.json({ error: 'unsupported_transport', message: error.message }, 400);
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
