import type { Database } from '@ema-agent/storage';
import { buildBindings, type AppBindings, type BuildBindingsArgs } from './bindings.js';
import { registerAllHooks }    from './register-hooks.js';
import { registerAllEmitters } from './register-emitters.js';
import { configureBridge }     from './bridge.js';
import { createBackgroundTicker } from './background-tick.js';
import { sweepStartupOrphanTurnFiles } from './startup-turn-files.js';
import { removeLegacyArtifactDirectories } from '../storage-locations/index.js';

// ── Constants ────────────────────────────────────────────────────────────────

const BACKGROUND_TICK_MS  = 5_000;      // poll background_tasks every 5 s
// 360 ticks × 5 s = 1800 s = 30 min between cleaner sweeps.
const CLEANER_SWEEP_EVERY = 360;
// 每 30 分钟尝试一次；缓存自身还会检查应用空闲和 6 小时最小维护间隔。
const ATTACHMENT_CACHE_SWEEP_EVERY = 360;
// 12 ticks × 5 s = 60 s between bridge readiness checks.
const BRIDGE_HEARTBEAT_EVERY = 12;

// ── wire — synchronous setup, returns bindings ───────────────────────────────

/**
 * Wire the full application:
 *
 *   1. buildBindings(db)        — construct every Facade (no side effects)
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

  // 2b-2) Orphan turn files — 删除级联提交 DB 后, 若进程在逐 turn 文件清理中途
  //       崩溃, DB 已是事实源但磁盘残留 turn 目录/文件。按 DB live 集合自检清除。
  try {
    const { removed } = sweepStartupOrphanTurnFiles(bindings.activeDataDir, bindings.session);
    if (removed > 0) console.log(`[session] startup: removed ${removed} orphan turn file entrie(s)`);
  } catch (err) {
    console.warn('[session] startup orphan turn file sweep skipped:', err);
  }

  // 2b-3) Data v21 只能删除 SQLite 表；旧版产生的 Artifact 目录在启动恢复中清掉。
  try {
    const removed = removeLegacyArtifactDirectories(bindings.activeDataDir);
    if (removed > 0) {
      console.log(`[session] startup: removed ${removed} legacy Artifact directories`);
    }
  } catch (err) {
    console.warn('[session] startup legacy artifact cleanup skipped:', err);
  }

  // 2c) 子 Agent 执行恢复：启动时仍为 running 的记录来自上次异常退出，统一标记失败。
  try {
    const recovered = bindings.agentRunStore.recoverInterrupted();
    if (recovered.length > 0) {
      console.log(`[agent-run] startup: marked ${recovered.length} interrupted run(s) as failed`);
    }
  } catch (err) {
    console.warn('[agent-run] startup recovery skipped:', err);
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
  //    on failure, never fail silently). Single-flight(B-025): 慢轮跳过不叠,
  //    关机先等在途轮再 drain。
  let lastBridgeReady: boolean | null = null;
  const ticker = createBackgroundTicker({
    intervalMs: BACKGROUND_TICK_MS,
    onTick: async (tickCount) => {
      await bindings.memory.tick().catch((err) => {
        console.warn('[memory] background tick failed:', err);
      });
      if (tickCount % CLEANER_SWEEP_EVERY === 0) {
        try {
          const { deleted, freedBytes } = bindings.toolResultCleaner.sweep();
          if (deleted > 0) {
            console.log(`[tool-results] cleaner: removed ${deleted} file(s), freed ${(freedBytes / 1024).toFixed(0)} KB`);
          }
        } catch (err) {
          console.warn('[tool-results] cleaner sweep failed:', err);
        }
      }
      if (tickCount % ATTACHMENT_CACHE_SWEEP_EVERY === 0) {
        try {
          const report = await bindings.attachmentCacheMaintenance.sweepIfIdle();
          if (report.ran && (report.deletedDerivations > 0 || report.deletedImages > 0)) {
            console.log(
              `[attachment-cache] cleaner: removed ${report.deletedDerivations} derivation(s)`
              + ` and ${report.deletedImages} image(s), freed ${(report.freedBytes / 1024).toFixed(0)} KB`,
            );
          }
        } catch (err) {
          console.warn('[attachment-cache] cleaner sweep failed:', err);
        }
      }
      if (tickCount % BRIDGE_HEARTBEAT_EVERY === 0) {
        // heartbeat 异常由 ticker 统一捕获记录, lastBridgeReady 保持上次值。
        lastBridgeReady = await checkBridgeHeartbeat(bindings, lastBridgeReady);
      }
    },
  });

  return {
    async shutdown() {
      // 先停在途 tick(B-025), 再 drain——否则 drain 与在途 tick 并发写。
      await ticker.stop();
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
 * LocalHost 定期探测 Bridge 健康状态，失败时明确降级，恢复后重新推送配置。
 * Bridge 常在手动开发环境中晚于 LocalHost 启动；只有启动时的一次配置会永久错过它。
 * 重复配置具有幂等性，状态切换时必须发出系统警告，让前端展示真实可用性。
 */
async function checkBridgeHeartbeat(
  bindings:  AppBindings,
  lastReady: boolean | null,
): Promise<boolean> {
  let ready = await bindings.narrative.isReady();
  if (!ready) {
    // Retry configure once before declaring it down — covers "bridge just
    // came up since the last tick" without waiting a full extra cycle.
    await bindings.providerRuntime.syncBridge().catch(() => {});
    ready = await bindings.narrative.isReady();
  }

  if (lastReady === null) {
    // 首 tick：如实报状态。down 则 warn「不可达」（bridge 没启动时给用户信号），
    // up 则静默（不算「恢复」，避免假报）。修 bug 2.1：原逻辑 null→false 不发事件，
    // 导致 bridge 从没启动时全程零用户信号。
    if (!ready) {
      console.warn('[bridge] narrative capability unavailable — degrading');
      bindings.systemBus.emit({ type: 'system_warning', level: 'warn', message: 'Narrative bridge 不可达 — narrative 模式暂时降级' });
    }
  } else if (!lastReady && ready) {
    console.log('[bridge] narrative capability recovered');
    bindings.systemBus.emit({ type: 'system_warning', level: 'info', message: 'Narrative bridge 已恢复' });
  } else if (lastReady && !ready) {
    console.warn('[bridge] narrative capability lost — degrading');
    bindings.systemBus.emit({ type: 'system_warning', level: 'warn', message: 'Narrative bridge 不可达 — narrative 模式暂时降级' });
  }
  return ready;
}

// Provider 配置解析仍供 LocalHost 内部装配与定向测试复用。
export type { BuildBindingsArgs } from './bindings.js';
export {
  buildLlmProviderConfig,
  buildEmbedProviderConfig,
  buildRerankProviderConfig,
} from './bindings.js';

export { fetchLlmModels, type FetchedModels } from './providers/llm.js';
export { fetchEmbedModels, type FetchedEmbedModels } from './providers/embed.js';
export { resolveBridgeUrl, configureBridge } from './bridge.js';
export { ProviderRuntimeFacade } from './provider-runtime.js';
export type { ProviderRuntimeDependencies } from './provider-runtime.js';
export { registerAllHooks }    from './register-hooks.js';
export { registerAllEmitters } from './register-emitters.js';
