// 提供 Skill 扫描、市场浏览、安装和启停 API。
import { Hono } from 'hono';
import { z }    from 'zod';
import { GithubSkillCoordsSchema, SkillNameSchema } from '@ema-agent/skills';
import { mergeByName } from '@ema-agent/marketplace';
import type { SkillInstaller, SkillStore, MarketSkillEntry } from '@ema-agent/skills';
import type { MarketRegistry, MarketSourceStore } from '@ema-agent/marketplace';

/** Skill 管理面只使用索引与安装能力，不接触运行时激活。 */
type SkillStoreManagement = Pick<
  SkillStore,
  'listAll' | 'findByName' | 'readRawMd' | 'setEnabled' | 'rename' | 'remove'
>;
type SkillInstallManagement = Pick<
  SkillInstaller,
  'installFromUrl' | 'installFromText' | 'validate'
>;
/** 市场聚合只需要启用源列表和跨源拉取。 */
type MarketSourceListing = Pick<MarketSourceStore, 'listEnabled'>;
type MarketEntryListing = Pick<MarketRegistry, 'listAll'>;

// ── Skills router ─────────────────────────────────────────────────────────────
//
// SQL 只缓存文件型 Skill 的索引；列表返回明确的 SKILL.md `path` 与 Bundle
// `dirPath`，正文仍在 SkillCall 激活时懒读，不通过管理 API 常驻内存。
//
// Routes:
//   GET    /api/skills                 list all (metadata)
//   POST   /api/skills                 install from text or URL
//   POST   /api/skills/validate        validate without installing
//   GET    /api/skills/:name           get single (metadata, incl. path/dirPath)
//   PATCH  /api/skills/:name           enable/disable
//   POST   /api/skills/:name/rename    rename (rewrites frontmatter + dir key)
//   POST   /api/skills/:name/relocate  V1 保留路由但 fail-closed，等待多 Root 事务
//   DELETE /api/skills/:name           uninstall (deletes dir; builtin → disable)

const installBodySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('text'), content: z.string().min(1) }),
  // coords: market entry 透传的 GitHub 坐标,bundle 安装优先用(不丢 sibling assets)。
  // 用户手动粘 URL 安装时无 coords,installer 会 URL 反解析兜底。
  z.object({
    source: z.literal('url'),
    url:    z.string().url(),
    sha256: z.string().optional(),
    coords: GithubSkillCoordsSchema.optional(),
  }),
]);

const validateBodySchema = z.object({ content: z.string().min(1) });
const patchBodySchema    = z.object({ enabled: z.boolean() });
const renameBodySchema   = z.object({ newName: SkillNameSchema });
const relocateBodySchema = z.object({ dir: z.string().min(1) });

export function createSkillsRouter(
  skillStore: SkillStoreManagement,
  skillInstaller: SkillInstallManagement,
  marketSources: MarketSourceListing,
  marketRegistry: MarketEntryListing,
) {
  const router = new Hono();

  router.get('/skills', (c) => {
    return c.json({ skills: skillStore.listAll() });
  });

  // ── Marketplace: list installable skills ──
  // 聚合所有 enabled 的 skill 源(market_sources 表),并发 fetch 合并。
  // 单源失败不阻断(返回该源 error)。源管理走 /api/market/sources。
  router.get('/skills/market', async (c) => {
    try {
      const sources = marketSources.listEnabled('skill');
      const results = await marketRegistry.listAll<MarketSkillEntry>(
        'skill',
        sources,
        c.req.raw.signal,
      );
      // 跨源按 name 去重,sortOrder 小的优先(与 mcp 对称,底座 mergeByName)
      const skills = mergeByName(results);
      return c.json({
        sources: results.map((r) => ({ id: r.sourceId, label: r.sourceLabel, type: r.sourceType, error: r.error, count: r.entries.length })),
        skills,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  router.post('/skills', async (c) => {
    let body: z.infer<typeof installBodySchema>;
    try {
      body = installBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'Invalid body' }, 400);
    }
    try {
      const record = body.source === 'url'
        ? await skillInstaller.installFromUrl(body.url, body.sha256, c.req.raw.signal, body.coords)
        : await skillInstaller.installFromText(body.content);
      return c.json({ skill: record }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 422);
    }
  });

  router.post('/skills/validate', async (c) => {
    let body: z.infer<typeof validateBodySchema>;
    try {
      body = validateBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'content is required' }, 400);
    }
    return c.json(skillInstaller.validate(body.content));
  });

  router.get('/skills/:name', (c) => {
    const record = skillStore.findByName(c.req.param('name'));
    if (!record) return c.json({ error: 'Skill not found' }, 404);
    return c.json({ skill: record });
  });

  // Raw SKILL.md (frontmatter + body) for the in-app viewer.
  router.get('/skills/:name/content', async (c) => {
    const name = c.req.param('name');
    if (!skillStore.findByName(name)) return c.json({ error: 'Skill not found' }, 404);
    try {
      return c.json({ content: await skillStore.readRawMd(name) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  router.patch('/skills/:name', async (c) => {
    let body: z.infer<typeof patchBodySchema>;
    try {
      body = patchBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'enabled (boolean) is required' }, 400);
    }
    try {
      skillStore.setEnabled(c.req.param('name'), body.enabled);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  router.post('/skills/:name/rename', async (c) => {
    let body: z.infer<typeof renameBodySchema>;
    try {
      body = renameBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'newName is required' }, 400);
    }
    try {
      await skillStore.rename(c.req.param('name'), body.newName);
      const skill = skillStore.findByName(body.newName);
      if (!skill) return c.json({ error: 'Renamed Skill was not indexed' }, 500);
      return c.json({ skill });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 422);
    }
  });

  router.post('/skills/:name/relocate', async (c) => {
    let body: z.infer<typeof relocateBodySchema>;
    try {
      body = relocateBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'dir is required' }, 400);
    }
    // V1 只有一个受信任 writable root；任意目录移动会在重启扫描时丢失索引。
    // 保留稳定路由供多 Root + 双根 journal 落地后启用，但当前必须显式 fail-closed。
    return c.json({
      error: 'skill_relocation_unavailable',
      message: 'Skill relocation requires multiple configured writable roots and is not available in V1',
    }, 501);
  });

  router.delete('/skills/:name', async (c) => {
    const name = c.req.param('name');
    if (!skillStore.findByName(name)) return c.json({ error: 'Skill not found' }, 404);
    await skillStore.remove(name);
    return c.json({ ok: true });
  });

  return router;
}
