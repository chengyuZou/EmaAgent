import { Hono } from 'hono';
import { z }    from 'zod';
import * as path from 'node:path';
import { asArtifactId, asSessionId } from '@ema-agent/contracts';
import type { AppBindings } from '../wiring.js';

// ── Artifacts router ──────────────────────────────────────────────────────────
//
// Routes:
//   GET  /api/sessions/:sessionId/artifacts         list (metadata only)
//   GET  /api/artifacts/:id                         single artifact with content
//   POST /api/artifacts/:id/apply                   copy content to workspace file
//   POST /api/artifacts/:id/reject                  mark as rejected
//   DELETE /api/artifacts/:id                       delete artifact + managed file

const applySchema = z.object({
  targetPath: z.string().min(1).max(2000),
});

export function createArtifactsRouter(bindings: AppBindings) {
  const router = new Hono();
  const { artifactStore, session: sessionStore } = bindings;

  // ── List by session ─────────────────────────────────────────────────────────
  router.get('/sessions/:sessionId/artifacts', (c) => {
    const sessionId = asSessionId(c.req.param('sessionId'));
    const type      = c.req.query('type');
    const list      = artifactStore.list(sessionId, type ? { type } : undefined);
    return c.json({ artifacts: list });
  });

  // ── Get single artifact (with content) ──────────────────────────────────────
  router.get('/artifacts/:id', (c) => {
    const id       = asArtifactId(c.req.param('id'));
    const artifact = artifactStore.get(id);
    if (!artifact) return c.json({ error: 'Artifact not found' }, 404);
    return c.json({ artifact });
  });

  // ── Apply to workspace ──────────────────────────────────────────────────────
  router.post('/artifacts/:id/apply', async (c) => {
    const id = asArtifactId(c.req.param('id'));

    let body: z.infer<typeof applySchema>;
    try {
      body = applySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'targetPath is required' }, 400);
    }

    // Resolve the artifact's session to get workspaceRoot for path validation
    const artifact = artifactStore.get(id);
    if (!artifact) return c.json({ error: 'Artifact not found' }, 404);

    const sess          = sessionStore.getSession(artifact.sessionId);
    const workspaceRoot = sess?.workspaceRoots[0] ?? '';
    const resolved      = path.resolve(body.targetPath);

    if (workspaceRoot && !resolved.startsWith(path.resolve(workspaceRoot) + path.sep)
                      && resolved !== path.resolve(workspaceRoot)) {
      return c.json({ error: 'targetPath must be inside the workspace root' }, 403);
    }

    try {
      const updated = artifactStore.apply(id, resolved);
      return c.json({ artifact: updated });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ── Reject ──────────────────────────────────────────────────────────────────
  router.post('/artifacts/:id/reject', (c) => {
    const id = asArtifactId(c.req.param('id'));
    try {
      const updated = artifactStore.reject(id);
      return c.json({ artifact: updated });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  // ── Delete ──────────────────────────────────────────────────────────────────
  router.delete('/artifacts/:id', (c) => {
    const id = asArtifactId(c.req.param('id'));
    artifactStore.delete(id);
    return c.json({ ok: true });
  });

  return router;
}
