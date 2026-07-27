import { Hono } from 'hono';
import { getDiagnostics } from '../wiring/diagnostic-sink.js';

/**
 * GET /api/diagnostics/hooks — return the HookBus trace ring buffer.
 * Frontend settings panel uses this for the "复制诊断信息" button.
 */
export function diagnosticRoute(): Hono {
  const app = new Hono();

  app.get('/hooks', (c) => {
    const diag = getDiagnostics();
    return c.json(diag);
  });

  return app;
}
