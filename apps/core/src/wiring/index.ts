import type { Database } from '@ema-agent/storage';
import { buildBindings, type AppBindings, type BuildBindingsArgs } from './bindings.js';
import { registerAllHooks }    from './register-hooks.js';
import { registerAllEmitters } from './register-emitters.js';
import { configureBridge }     from './bridge.js';

// ── Constants ────────────────────────────────────────────────────────────────

const BACKGROUND_TICK_MS  = 5_000;      // poll background_tasks every 5 s
// 360 ticks × 5 s = 1800 s = 30 min between cleaner sweeps.
const CLEANER_SWEEP_EVERY = 360;
// 12 ticks × 5 s = 60 s between bridge readiness checks.
const BRIDGE_HEARTBEAT_EVERY = 12;

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

  // 2c) Agent task crash recovery — any task still running or waiting_user at
  //     startup was orphaned by a process kill; mark them failed.
  try {
    const recovered = bindings.taskStore.recoverInterrupted();
    if (recovered.length > 0) {
      console.log(`[agent-task] startup: marked ${recovered.length} interrupted task(s) as failed`);
    }
  } catch (err) {
    console.warn('[agent-task] startup recovery skipped:', err);
  }

  // 3) MCP — prime tools from cache synchronously (instant visibility, no connect),
  //    then refresh connections in the background. Transports open lazily on first
  //    callTool, so a slow/offline server never blocks startup.
  try {
    const primed = bindings.mcpRegistry.primeFromCache();
    if (primed > 0) console.info(`[mcp] primed ${primed} tool(s) from cache`);
  } catch (err) {
    console.warn('[mcp] primeFromCache() failed:', err);
  }
  void bindings.mcpRegistry.startAll().catch((err) => {
    console.warn('[mcp] startAll() refresh failed:', err);
  });

  // 4) Periodic tick — drains background_tasks queue + sweeps tool-result files
  //    + bridge heartbeat (CLAUDE.md red line: ping /health, mark unavailable
  //    on failure, never fail silently).
  let tickCount = 0;
  // null = not checked yet (don't emit a spurious "recovered" on the first tick).
  let lastBridgeReady: boolean | null = null;
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
    if (tickCount % BRIDGE_HEARTBEAT_EVERY === 0) {
      void checkBridgeHeartbeat(bindings, lastBridgeReady).then((ready) => {
        lastBridgeReady = ready;
      });
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

/**
 * Bridge heartbeat — CLAUDE.md red line: "apps/core 定期 ping /health，失败时
 * 主动标记 unavailable 并触发降级；禁止静默失败". Without this, a bridge that
 * starts AFTER core (the common manual-start order) never gets configured —
 * core's one-shot fire-and-forget `configureBridge` at startup already failed
 * and nothing ever retries it.
 *
 * Idempotent: re-pushing the same config to an already-configured bridge just
 * makes it rebuild its NarrativeManager (cheap, observed safe in practice).
 * Emits a `system_warning` on every down↔up transition so the frontend status
 * bar reflects reality instead of staying silent.
 */
async function checkBridgeHeartbeat(
  bindings:  AppBindings,
  lastReady: boolean | null,
): Promise<boolean> {
  let ready = await bindings.narrative.isReady();
  if (!ready) {
    // Retry configure once before declaring it down — covers "bridge just
    // came up since the last tick" without waiting a full extra cycle.
    await configureBridge(bindings.profileDb, bindings.narrative).catch(() => {});
    ready = await bindings.narrative.isReady();
  }

  if (lastReady === false && ready) {
    console.log('[bridge] narrative capability recovered');
    bindings.systemBus.emit({ type: 'system_warning', level: 'info', message: 'Narrative bridge 已恢复' });
  } else if (lastReady === true && !ready) {
    console.warn('[bridge] narrative capability lost — degrading');
    bindings.systemBus.emit({ type: 'system_warning', level: 'warn', message: 'Narrative bridge 不可达 — narrative 模式暂时降级' });
  }
  return ready;
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
