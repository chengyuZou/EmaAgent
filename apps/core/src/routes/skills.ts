import { Hono } from 'hono';
import { z }    from 'zod';
import type { AppBindings } from '../wiring.js';

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
  z.object({ source: z.literal('url'),  url: z.string().url(), sha256: z.string().optional() }),
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

  router.post('/skills', async (c) => {
    let body: z.infer<typeof installBodySchema>;
    try {
      body = installBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'Invalid body' }, 400);
    }
    try {
      const record = body.source === 'url'
        ? await skillInstaller.installFromUrl(body.url, body.sha256)
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
