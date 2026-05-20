import type { Database } from '@ema-agent/storage';
import { buildBindings, type AppBindings } from './bindings.js';
import { registerAllHooks }    from './register-hooks.js';
import { registerAllEmitters } from './register-emitters.js';

// ── wire — single entry point used by sidecar + future CLI ──────────────────

/**
 * Wire the full application:
 *
 *   1. buildBindings(db)        — construct every Façade (no side effects)
 *   2. registerAllHooks(...)    — attach HookBus subscribers from every package
 *   3. registerAllEmitters(...) — attach module-emitter subscribers
 *
 * Returns the populated AppBindings. Used by:
 *   apps/core/src/index.ts   — sidecar startup (then buildServer + serve)
 *   apps/cli/src/index.ts    — future CLI (then orchestrator.run() directly)
 *
 * Caller is responsible for: db.migrate() before this, db.close() at shutdown.
 */
export function wire(db: Database): AppBindings {
  const bindings = buildBindings(db);
  registerAllHooks(bindings);
  registerAllEmitters(bindings);
  return bindings;
}

// ── Public re-exports (back-compat for existing routes / orchestrator) ──────

export type { AppBindings } from './bindings.js';
export {
  buildLlmProviderConfig,
  buildEmbedProviderConfig,
  buildRerankProviderConfig,
} from './bindings.js';

export { resolveBridgeUrl, configureBridge } from './bridge.js';
export { registerAllHooks }    from './register-hooks.js';
export { registerAllEmitters } from './register-emitters.js';
