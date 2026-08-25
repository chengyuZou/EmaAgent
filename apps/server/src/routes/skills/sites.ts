// 技能市场站点：源 CRUD、索引刷新（304/对账在包内）与按条目安装。
import { Hono } from 'hono';
import { z } from 'zod';
import {
  installSkillFromSite,
  refreshSites,
  type SkillRegistry,
  type SkillSiteStore,
  type SkillStore,
} from '@ema-agent/skills';
import { jsonBody } from '../validate.js';

export interface SkillSitesRouteDeps {
  readonly skillSites: Pick<
    SkillSiteStore,
    | 'list'
    | 'listEnabled'
    | 'get'
    | 'create'
    | 'update'
    | 'remove'
    | 'touchFetched'
    | 'saveFetchSuccess'
    | 'saveFetchFailure'
  >;
  readonly skillStore: Pick<SkillStore, 'finalizeInstall'>;
  /** 安装成功后重扫 builtin+user，让新技能进入目录。 */
  readonly skills: Pick<SkillRegistry, 'refreshCore'>;
  /** 安装 staging 与 rename 同卷的约束来源。 */
  readonly skillUserRoot: string;
}

const siteAddBody = z.object({
  label: z.string().trim().min(1).max(100),
  indexUrl: z.url(),
  autoUpdate: z.boolean().optional(),
});

const sitePatchBody = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  autoUpdate: z.boolean().optional(),
});

const installBody = z.object({
  siteId: z.string().min(1),
  entryId: z.string().min(1),
});

export const skillSitesRoute = (deps: SkillSitesRouteDeps) =>
  new Hono()
    .get('/sites', context => {
      return context.json({ items: deps.skillSites.list() });
    })
    .post('/sites', jsonBody(siteAddBody), async context => {
      return context.json(deps.skillSites.create(context.req.valid('json')), 201);
    })
    .patch('/sites/:id', jsonBody(sitePatchBody), async context => {
      const id = context.req.param('id');
      if (!deps.skillSites.get(id)) return context.json({ error: 'site_not_found' }, 404);
      deps.skillSites.update(id, context.req.valid('json'));
      return context.json(deps.skillSites.get(id));
    })
    .delete('/sites/:id', context => {
      if (!deps.skillSites.remove(context.req.param('id'))) {
        return context.json({ error: 'site_not_found_or_builtin' }, 404);
      }
      return context.json({ ok: true });
    })
    // 全站刷新：各站成败独立报告，不阻断其他站点。
    .post('/sites/refresh', async context => {
      const reports = await refreshSites({ store: deps.skillSites });
      return context.json({ items: reports });
    })
    // 安装以站点缓存索引的条目为准；先刷新再安装由前端按 UI 顺序决定。
    .post('/sites/install', jsonBody(installBody), async context => {
      const { siteId, entryId } = context.req.valid('json');
      const site = deps.skillSites.get(siteId);
      if (!site) return context.json({ error: 'site_not_found' }, 404);
      const entry = site.index?.skills.find(candidate => candidate.id === entryId);
      if (!entry) {
        return context.json({ error: 'entry_not_found', message: '该条目不在站点缓存索引中，请先刷新' }, 404);
      }
      try {
        const descriptor = await installSkillFromSite(
          { siteId: site.id, entry },
          { store: deps.skillStore, userRoot: deps.skillUserRoot },
        );
        await deps.skills.refreshCore();
        return context.json(descriptor, 201);
      } catch (error) {
        return context.json({ error: 'install_failed', message: errorMessage(error) }, 422);
      }
    });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
