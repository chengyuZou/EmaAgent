// MCP Registry 目录源：源 CRUD、聚合浏览、现场安装与 stdio 拉起批准回答。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  fetchRegistryEntries,
  fetchRegistryEntryLatest,
  installRegistryEntry,
  resolveRegistryEntry,
  type McpRegistry,
  type McpRegistrySourceStore,
} from '@ema-agent/mcp';
import type { McpStdioApprovalChannel } from '../../composition/tools.js';

export interface McpRegistryRouteDeps {
  readonly mcp: Pick<McpRegistry, 'register'>;
  readonly mcpSources: Pick<
    McpRegistrySourceStore,
    'list' | 'listEnabled' | 'get' | 'add' | 'update' | 'remove'
  >;
  readonly stdioApprovals: Pick<McpStdioApprovalChannel, 'answer'>;
}

const sourceAddBody = z.object({
  label: z.string().trim().min(1).max(100),
  registryUrl: z.url(),
});

const sourcePatchBody = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  registryUrl: z.url().optional(),
  enabled: z.boolean().optional(),
});

const installBody = z.object({
  sourceId: z.string().min(1),
  entryName: z.string().min(1),
  name: z.string().trim().min(1).max(100).optional(),
  inputs: z.record(z.string(), z.string()).optional(),
});

const approvalBody = z.object({
  approved: z.boolean(),
});

export function mcpRegistryRoute(deps: McpRegistryRouteDeps): Hono {
  const app = new Hono();

  app.get('/registry-sources', context => {
    return context.json({ items: deps.mcpSources.list() });
  });

  app.post('/registry-sources', async context => {
    const parsed = sourceAddBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    return context.json(deps.mcpSources.add(parsed.data.label, parsed.data.registryUrl), 201);
  });

  app.patch('/registry-sources/:id', async context => {
    const id = context.req.param('id');
    if (!deps.mcpSources.get(id)) return context.json({ error: 'source_not_found' }, 404);
    const parsed = sourcePatchBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    deps.mcpSources.update(id, parsed.data);
    return context.json(deps.mcpSources.get(id));
  });

  // builtin（官方源）拒删；删除不影响已安装 server（溯源悬空，UI 提示）。
  app.delete('/registry-sources/:id', context => {
    if (!deps.mcpSources.remove(context.req.param('id'))) {
      return context.json({ error: 'source_not_found_or_builtin' }, 404);
    }
    return context.json({ ok: true });
  });

  app.post('/registry-sources/:id/test', async context => {
    const source = deps.mcpSources.get(context.req.param('id'));
    if (!source) return context.json({ error: 'source_not_found' }, 404);
    try {
      const result = await fetchRegistryEntries(source.registryUrl, {
        signal: context.req.raw.signal,
        maxPages: 1,
      });
      return context.json({ ok: true, sampleCount: result.entries.length, skipped: result.skipped });
    } catch (error) {
      return context.json({ ok: false, error: errorMessage(error) }, 502);
    }
  });

  // 聚合全部启用源；单源失败降级为该源 error，不拖垮其他源。
  app.get('/registry-entries', async context => {
    const results = await Promise.all(deps.mcpSources.listEnabled().map(async source => {
      try {
        const result = await fetchRegistryEntries(source.registryUrl, {
          signal: context.req.raw.signal,
        });
        return {
          sourceId: source.id,
          label: source.label,
          entries: result.entries.map(resolveRegistryEntry),
          skipped: result.skipped,
          truncated: result.truncated,
          error: null as string | null,
        };
      } catch (error) {
        return {
          sourceId: source.id,
          label: source.label,
          entries: [] as ReturnType<typeof resolveRegistryEntry>[],
          skipped: 0,
          truncated: false,
          error: errorMessage(error) as string | null,
        };
      }
    }));
    return context.json({
      sources: results.map(({ entries, ...rest }) => ({ ...rest, count: entries.length })),
      items: results.flatMap(result =>
        result.entries.map(entry => ({ ...entry, registrySourceId: result.sourceId }))),
    });
  });

  // 安装始终从源现场取该条目最新版本再解析，不用浏览缓存。
  app.post('/registry-install', async context => {
    const parsed = installBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const source = deps.mcpSources.get(parsed.data.sourceId);
    if (!source) return context.json({ error: 'source_not_found' }, 404);

    let raw;
    try {
      raw = await fetchRegistryEntryLatest(source.registryUrl, parsed.data.entryName, {
        signal: context.req.raw.signal,
      });
    } catch (error) {
      return context.json({ error: 'registry_fetch_failed', message: errorMessage(error) }, 502);
    }
    if (!raw) {
      return context.json({ error: 'entry_not_found', message: `条目 ${parsed.data.entryName} 在该源不存在或版本不可用` }, 404);
    }

    const entry = resolveRegistryEntry(raw);
    try {
      const id = installRegistryEntry({
        store: deps.mcp,
        source,
        entry,
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(parsed.data.inputs === undefined ? {} : { inputs: parsed.data.inputs }),
      });
      return context.json({ id, entry: { name: entry.name, version: entry.version } }, 201);
    } catch (error) {
      return context.json({ error: 'install_failed', message: errorMessage(error) }, 422);
    }
  });

  // stdio 拉起批准：管理面动作不进 Session FIFO；未知/已超时 requestId 返回 404。
  app.post('/stdio-approvals/:requestId', async context => {
    const parsed = approvalBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    if (!deps.stdioApprovals.answer(context.req.param('requestId'), parsed.data.approved)) {
      return context.json({ error: 'approval_not_found' }, 404);
    }
    return context.json({ ok: true });
  });

  return app;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
