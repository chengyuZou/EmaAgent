import { Hono } from 'hono';
import { probeShell, installGitViaWinget } from '@ema-agent/sandbox';

const app = new Hono();

/**
 * GET /api/system/shell
 * Returns the current shell probe result (cached; use ?fresh=1 to re-probe).
 */
app.get('/', (c) => {
  const fresh = c.req.query('fresh') === '1';
  return c.json(probeShell({ fresh }));
});

/**
 * POST /api/system/shell/install-git
 * Installs Git for Windows via winget. Blocks until done (1-3 min).
 * Re-probes on success so the next GET reflects the new state.
 */
app.post('/install-git', async (c) => {
  const result = await installGitViaWinget();
  return c.json(result);
});

export function shellRoute(): Hono { return app; }
