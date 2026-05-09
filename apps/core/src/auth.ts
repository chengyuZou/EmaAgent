import { Context, Next } from 'hono';

const EMA_SECRET_HEADER = 'x-ema-secret';

/**
 * Hono middleware that validates the X-Ema-Secret header.
 * Only applies to non-health routes; /health is always public.
 *
 * The secret is read from EMA_SHARED_SECRET env var, injected by Tauri at startup.
 * If the env var is absent (dev mode without Tauri), the check is skipped with a warning.
 */
export function emaAuth() {
  const secret = process.env['EMA_SHARED_SECRET'];

  if (!secret) {
    console.warn('[auth] EMA_SHARED_SECRET not set — secret check disabled (dev mode)');
  }

  return async (c: Context, next: Next) => {
    // Health endpoint is always public
    if (c.req.path === '/health') {
      return next();
    }

    if (!secret) return next();

    const provided = c.req.header(EMA_SECRET_HEADER);
    if (provided !== secret) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    return next();
  };
}
