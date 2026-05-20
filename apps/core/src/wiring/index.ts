import type { Database } from '@ema-agent/storage';
import { buildBindings, type AppBindings } from './bindings.js';
import { registerAllHooks }    from './register-hooks.js';
import { registerAllEmitters } from './register-emitters.js';

// ── Constants ────────────────────────────────────────────────────────────────

const BACKGROUND_TICK_MS = 5_000;       // poll background_tasks every 5 s

// ── wire — synchronous setup, returns bindings ───────────────────────────────

/**
 * Wire the full application:
 *
 *   1. buildBindings(db)        — construct every Façade (no side effects)
 *   2. registerAllHooks(...)    — attach HookBus subscribers from every package
 *   3. registerAllEmitters(...) — attach module-emitter subscribers
 *
 * Returns the populated AppBindings synchronously. Async initialization
 * (vector index rebuild, background task polling) is delegated to
 * `startBackgroundWork` so the caller controls its lifecycle.
 *
 * Caller is responsible for: db.migrate() before this, db.close() at shutdown.
 */
export function wire(db: Database): AppBindings {
  const bindings = buildBindings(db);
  registerAllHooks(bindings);
  registerAllEmitters(bindings);
  return bindings;
}

// ── Background work: init + periodic tick ────────────────────────────────────

export interface BackgroundHandle {
  /** Stop the periodic tick and drain in-flight session tasks. */
  shutdown(): Promise<void>;
}

/**
 * Kick off everything that needs to run AFTER wire() but BEFORE we accept
 * the first turn. Idempotent enough that re-calling would be harmless — but
 * normal flow is exactly once at process start.
 *
 *   - memory.initialize() — build vector indexes from existing DB rows
 *   - startup recovery   — reset orphaned 'running' background tasks → 'pending'
 *   - periodic tick      — drain background_tasks queue
 *
 * Returns a handle whose shutdown() must be called on process exit. The
 * sidecar wires this into SIGINT/SIGTERM; CLI can skip it for one-shot runs.
 */
export function startBackgroundWork(bindings: AppBindings): BackgroundHandle {
  // 1) Index build — async, fire-and-forget. plan() works without indexes
  //    (falls back to DB-scan + brute force), so this not finishing isn't
  //    fatal — it just degrades recall latency for the first few turns.
  void bindings.memory.initialize().catch((err) => {
    console.warn('[memory] initialize() failed — continuing with no vector index:', err);
  });

  // 2) Startup recovery — reset stuck 'running' tasks, clean orphans, scan
  //    for stale embeddings. Sync, all-tolerant. Logged for telemetry.
  try {
    const report = bindings.memory.runStartupRecovery();
    if (report.resetTasks      > 0) console.log(`[memory] startup: reset ${report.resetTasks} stuck task(s)`);
    if (report.orphanLazyUpdates > 0) console.log(`[memory] startup: cleaned ${report.orphanLazyUpdates} orphan lazy_update(s)`);
    if (report.staleNodeEmbeds + report.staleItemEmbeds > 0) {
      console.warn(`[memory] startup: ${report.staleNodeEmbeds} stale node embeds, ${report.staleItemEmbeds} stale item embeds (provider may have changed)`);
    }
    if (report.pendingSessions > 0) console.log(`[memory] startup: ${report.pendingSessions} session(s) have pending fragments`);
  } catch (err) {
    console.warn('[memory] startup recovery skipped:', err);
  }

  // 3) Periodic tick — drains background_tasks queue.
  const ticker = setInterval(() => {
    void bindings.memory.tick().catch((err) => {
      console.warn('[memory] background tick failed:', err);
    });
  }, BACKGROUND_TICK_MS);
  ticker.unref?.();

  return {
    async shutdown() {
      clearInterval(ticker);
      try { await bindings.memory.drain(); }
      catch (err) {
        console.warn('[memory] drain() failed during shutdown:', err);
      }
    },
  };
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
