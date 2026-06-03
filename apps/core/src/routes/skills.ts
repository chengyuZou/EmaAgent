import { Hono } from 'hono';
import { z }    from 'zod';
import type { AppBindings } from '../wiring.js';

// ── Skills router ─────────────────────────────────────────────────────────────
//
// Routes:
//   GET  /api/skills                     list all skills
//   POST /api/skills                     install from text or URL
//   POST /api/skills/validate            validate without installing
//   GET  /api/skills/:name               get single skill (with rawMd)
//   PATCH /api/skills/:name              enable/disable
//   DELETE /api/skills/:name             uninstall

const installBodySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('text'), content: z.string().min(1) }),
  z.object({ source: z.literal('url'),  url:     z.string().url() }),
]);

const validateBodySchema = z.object({ content: z.string().min(1) });

const patchBodySchema = z.object({ enabled: z.boolean() });

export function createSkillsRouter(bindings: AppBindings) {
  const router = new Hono();
  const { skillInstaller, skillStore } = bindings;

  // ── List ────────────────────────────────────────────────────────────────────
  router.get('/skills', (c) => {
    const skills = skillStore.listAll().map(({ rawMd: _, ...rest }) => rest);
    return c.json({ skills });
  });

  // ── Install ─────────────────────────────────────────────────────────────────
  router.post('/skills', async (c) => {
    let body: z.infer<typeof installBodySchema>;
    try {
      body = installBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'Invalid body' }, 400);
    }

    try {
      const record = body.source === 'url'
        ? await skillInstaller.installFromUrl(body.url)
        : skillInstaller.installFromText(body.content);
      const { rawMd: _, ...safe } = record;
      return c.json({ skill: safe }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 422);
    }
  });

  // ── Validate ────────────────────────────────────────────────────────────────
  router.post('/skills/validate', async (c) => {
    let body: z.infer<typeof validateBodySchema>;
    try {
      body = validateBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'content is required' }, 400);
    }
    const result = skillInstaller.validate(body.content);
    return c.json(result);
  });

  // ── Get single ──────────────────────────────────────────────────────────────
  router.get('/skills/:name', (c) => {
    const record = skillStore.findByName(c.req.param('name'));
    if (!record) return c.json({ error: 'Skill not found' }, 404);
    return c.json({ skill: record });
  });

  // ── Enable / disable ────────────────────────────────────────────────────────
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

  // ── Delete ──────────────────────────────────────────────────────────────────
  router.delete('/skills/:name', (c) => {
    skillStore.remove(c.req.param('name'));
    return c.json({ ok: true });
  });

  return router;
}
