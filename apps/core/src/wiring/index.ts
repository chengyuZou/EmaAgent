import type { Database } from '@ema-agent/storage';
import { buildBindings, type AppBindings, type BuildBindingsArgs } from './bindings.js';
import { registerAllHooks }    from './register-hooks.js';
import { registerAllEmitters } from './register-emitters.js';

// ── Constants ────────────────────────────────────────────────────────────────

const BACKGROUND_TICK_MS  = 5_000;      // poll background_tasks every 5 s
// 360 ticks × 5 s = 1800 s = 30 min between cleaner sweeps.
const CLEANER_SWEEP_EVERY = 360;

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
export function wire(args: BuildBindingsArgs): AppBindings {
  const bindings = buildBindings(args);
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

  // 2a) Startup recovery — reset stuck 'running' tasks, clean orphans, scan
  //     for stale embeddings. Sync, all-tolerant. Logged for telemetry.
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

  // 2b) Startup recovery — heal any agent turns left in 'running'/'pending'
  //     state by a prior process crash. Per-session lazy healing (startTurn)
  //     covers the common case; this global scan covers sessions that never
  //     resume after the crash.
  try {
    const { healed } = bindings.session.recoverStuckTurns();
    if (healed > 0) console.log(`[session] startup: aborted ${healed} stuck turn(s) from prior crash`);
  } catch (err) {
    console.warn('[session] startup turn recovery skipped:', err);
  }

  // 3) MCP — connect all globally-enabled servers (fire-and-forget; failures logged)
  void bindings.mcpRegistry.startAll().catch((err) => {
    console.warn('[mcp] startAll() failed:', err);
  });

  // 4) Periodic tick — drains background_tasks queue + sweeps tool-result files.
  let tickCount = 0;
  const ticker = setInterval(() => {
    tickCount++;
    void bindings.memory.tick().catch((err) => {
      console.warn('[memory] background tick failed:', err);
    });
    if (tickCount % CLEANER_SWEEP_EVERY === 0) {
      try {
        const { deleted, freedBytes } = bindings.toolResultCleaner.sweep();
        if (deleted > 0) {
          console.log(`[agent-context] cleaner: removed ${deleted} file(s), freed ${(freedBytes / 1024).toFixed(0)} KB`);
        }
      } catch (err) {
        console.warn('[agent-context] cleaner sweep failed:', err);
      }
    }
  }, BACKGROUND_TICK_MS);
  ticker.unref?.();

  return {
    async shutdown() {
      clearInterval(ticker);
      try { await bindings.memory.drain(); }
      catch (err) {
        console.warn('[memory] drain() failed during shutdown:', err);
      }
      try { await bindings.mcpRegistry.disconnectAll(); }
      catch (err) {
        console.warn('[mcp] disconnectAll() failed during shutdown:', err);
      }
    },
  };
}

// ── Public re-exports (back-compat for existing routes / orchestrator) ──────

export type { AppBindings, BuildBindingsArgs } from './bindings.js';
export {
  buildLlmProviderConfig,
  buildEmbedProviderConfig,
  buildRerankProviderConfig,
} from './bindings.js';

export { fetchLlmModels, type FetchedModels } from './providers/llm.js';
export { fetchEmbedModels, type FetchedEmbedModels } from './providers/embed.js';
export { resolveBridgeUrl, configureBridge } from './bridge.js';
export { registerAllHooks }    from './register-hooks.js';
export { registerAllEmitters } from './register-emitters.js';
