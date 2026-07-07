import { Hono } from 'hono';
import { z }    from 'zod';
import { GithubSkillCoordsSchema } from '@ema-agent/skill';
import { mergeByName } from '@ema-agent/marketplace';
import type { MarketSkillEntry } from '@ema-agent/skill';
import type { AppBindings } from '../wiring/index.js';

// ── Skills router ─────────────────────────────────────────────────────────────
//
// File-backed skills: the SQL index is a cache over <dirPath>/SKILL.md. Records
// returned here are metadata only (no body) — the body is read lazily on
// activation via the skill_call tool. `dirPath` lets the UI "open in editor".
//
// Routes:
//   GET    /api/skills                 list all (metadata)
//   POST   /api/skills                 install from text or URL
//   POST   /api/skills/validate        validate without installing
//   GET    /api/skills/:name           get single (metadata, incl. dirPath)
//   PATCH  /api/skills/:name           enable/disable
//   POST   /api/skills/:name/rename    rename (rewrites frontmatter + dir key)
//   POST   /api/skills/:name/relocate  move the skill directory (搬家)
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
const renameBodySchema   = z.object({ newName: z.string().min(1) });
const relocateBodySchema = z.object({ dir: z.string().min(1) });

export function createSkillsRouter(bindings: AppBindings) {
  const router = new Hono();
  const { skillInstaller, skillStore } = bindings;

  router.get('/skills', (c) => {
    return c.json({ skills: skillStore.listAll() });
  });

  // ── Marketplace: list installable skills ──
  // 聚合所有 enabled 的 skill 源(market_sources 表),并发 fetch 合并。
  // 单源失败不阻断(返回该源 error)。源管理走 /api/market/sources。
  router.get('/skills/market', async (c) => {
    try {
      const sources = bindings.marketSourceStore.listEnabled('skill');
      const results = await bindings.marketRegistry.listAll<MarketSkillEntry>('skill', sources);
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
        ? await skillInstaller.installFromUrl(body.url, body.sha256, undefined, body.coords)
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
      return c.json({ ok: true });
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
    try {
      await skillStore.relocate(c.req.param('name'), body.dir);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 422);
    }
  });

  router.delete('/skills/:name', async (c) => {
    const name = c.req.param('name');
    if (!skillStore.findByName(name)) return c.json({ error: 'Skill not found' }, 404);
    await skillStore.remove(name);
    return c.json({ ok: true });
  });

  return router;
}
