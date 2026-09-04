// 技能市场：聚合浏览/详情/文件预览/安装/卸载。来源固定 SkillHub + ClawHub,用户不能加源。
import { Hono } from 'hono';
import { z } from 'zod';
import {
  MarketInstallError,
  MarketUpstreamError,
  MARKET_SOURCES,
  type MarketInstaller,
  type MarketService,
  type SkillRegistry,
} from '@ema-agent/skills';
import { jsonBody, queryValidator } from '../validate.js';
import type { AppEvent } from '../../sse/eventHub.js';

export interface SkillMarketRouteDeps {
  readonly market: MarketService;
  readonly installer: MarketInstaller;
  /** 安装/卸载后重扫 builtin+user,让目录变化进索引。 */
  readonly skills: Pick<SkillRegistry, 'refreshCore'>;
  readonly emitApp: (event: AppEvent) => void;
}

const sourceSchema = z.enum(MARKET_SOURCES as ['skillhub', 'clawhub']);

const listQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  source: z.union([sourceSchema, z.literal('all')]).default('all'),
  installed: z.enum(['all', 'installed', 'installable']).default('all'),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});

const detailQuery = z.object({
  path: z.string().min(1).max(512),
});

const installBody = z.object({
  source: sourceSchema,
  slug: z.string().min(1).max(256),
});

export const skillMarketRoute = (deps: SkillMarketRouteDeps) =>
  new Hono()
    .get('/market/skills', queryValidator(listQuery), async context => {
      const query = context.req.valid('query');
      try {
        return context.json(await deps.market.list({
          ...(query.q ? { q: query.q } : {}),
          source: query.source,
          installed: query.installed,
          ...(query.cursor ? { cursor: query.cursor } : {}),
          limit: query.limit,
        }));
      } catch (error) {
        const mapped = toMarketError(error);
        return context.json(mapped.body, mapped.status);
      }
    })
    .get('/market/status', context => context.json(deps.market.status()))
    .get('/market/skills/:source/:slug', async context => {
      const source = sourceSchema.safeParse(context.req.param('source'));
      if (!source.success) return context.json({ error: 'invalid_source' }, 400);
      try {
        return context.json(await deps.market.detail(source.data, context.req.param('slug')));
      } catch (error) {
        const mapped = toMarketError(error);
        return context.json(mapped.body, mapped.status);
      }
    })
    .get('/market/skills/:source/:slug/file', queryValidator(detailQuery), async context => {
      const source = sourceSchema.safeParse(context.req.param('source'));
      if (!source.success) return context.json({ error: 'invalid_source' }, 400);
      try {
        return context.json(await deps.market.fileContent(source.data, context.req.param('slug'), context.req.valid('query').path));
      } catch (error) {
        const mapped = toMarketError(error);
        return context.json(mapped.body, mapped.status);
      }
    })
    .post('/market/install', jsonBody(installBody), async context => {
      const { source, slug } = context.req.valid('json');
      try {
        const result = await deps.installer.install(source, slug);
        await deps.skills.refreshCore();
        deps.emitApp({ type: 'skills_changed' });
        return context.json(result, 201);
      } catch (error) {
        const mapped = toMarketError(error);
        return context.json(mapped.body, mapped.status);
      }
    })
    .post('/market/uninstall', jsonBody(installBody), async context => {
      const { source, slug } = context.req.valid('json');
      try {
        await deps.installer.uninstall(source, slug);
        await deps.skills.refreshCore();
        deps.emitApp({ type: 'skills_changed' });
        return context.json({ ok: true });
      } catch (error) {
        const mapped = toMarketError(error);
        return context.json(mapped.body, mapped.status);
      }
    });

/** 市场错误映射：保留业务码与 HTTP 语义（上游 502、冲突 409、不可装 422）。 */
function toMarketError(error: unknown): {
  body: { error: string; message: string };
  status: 400 | 409 | 422 | 500 | 502;
} {
  if (error instanceof MarketInstallError) {
    return {
      body: { error: error.code, message: error.message },
      status: error.httpStatus === 409 ? 409 : error.httpStatus === 400 ? 400 : 422,
    };
  }
  if (error instanceof MarketUpstreamError) {
    return { body: { error: error.code, message: error.message }, status: 502 };
  }
  return {
    body: { error: 'market_internal', message: error instanceof Error ? error.message : String(error) },
    status: 500,
  };
}
