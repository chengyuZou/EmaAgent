// 管理 LocalHost 启动后常驻的恢复、维护、Bridge 探测与有序关闭。

import type { AttachmentCacheMaintenance } from '@ema-agent/attachment';
import type { McpRegistry } from '@ema-agent/mcp';
import type { MemoryPlanner } from '@ema-agent/memory';
import type { NarrativeClient } from '@ema-agent/narrative';
import type { SessionStore } from '@ema-agent/session';
import type { ToolResultCleaner } from '@ema-agent/tools';
import type { SystemEventBus } from '../sse/system-bus.js';
import type { ProviderRuntimeFacade } from '../wiring/provider-runtime.js';
import {
  createBackgroundTicker,
  type BackgroundTicker,
} from './backgroundTicker.js';
import type { StartupRecovery } from './startupRecovery.js';
import {
  HEAVY_MAINTENANCE_IDLE_MS,
  LIGHT_MAINTENANCE_IDLE_MS,
  WorkloadIdlePolicy,
} from './workloadIdlePolicy.js';

const BACKGROUND_TICK_MS = 5_000;
const CLEANER_SWEEP_EVERY = 360;
const ATTACHMENT_CACHE_SWEEP_EVERY = 360;
const BRIDGE_HEARTBEAT_EVERY = 12;
const MEMORY_DECAY_SWEEP_EVERY = 12;

type BackgroundMemory = Pick<
  MemoryPlanner,
  | 'initialize'
  | 'tick'
  | 'drain'
  | 'runMaintenance'
  | 'consolidatePendingNodes'
  | 'repairStaleEmbeddings'
  | 'enforceStorageBudget'
>;
type ForegroundActivity = Pick<
  SessionStore,
  'hasActiveTurns' | 'subscribeActiveTurns'
>;
type BackgroundMcp = Pick<
  McpRegistry,
  'primeFromCache' | 'discoverUncached' | 'disconnectAll'
>;
type BackgroundToolResults = Pick<ToolResultCleaner, 'sweep'>;
type BackgroundAttachmentCache = Pick<
  AttachmentCacheMaintenance,
  'sweepIfIdle'
>;
type BackgroundNarrative = Pick<NarrativeClient, 'isReady'>;
type BackgroundProviderRuntime = Pick<ProviderRuntimeFacade, 'syncBridge'>;
type BackgroundSystemEvents = Pick<SystemEventBus, 'emit'>;

export class BackgroundWork {
  private ticker: BackgroundTicker | null = null;
  private initialization: Promise<unknown> | null = null;
  private mcpDiscovery: Promise<unknown> | null = null;
  private lastBridgeReady: boolean | null = null;
  private memoryEnabled = false;
  private lastHeavyMaintenanceAt = 0;
  private started = false;
  private stopped = false;
  private readonly idlePolicy = new WorkloadIdlePolicy();
  private maintenanceAbortController: AbortController | null = null;
  private unsubscribeActiveTurns: (() => void) | null = null;

  constructor(
    private readonly startupRecovery: Pick<
      StartupRecovery,
      'runRequired' | 'runMaintenance'
    >,
    private readonly foregroundActivity: ForegroundActivity,
    private readonly memory: BackgroundMemory,
    private readonly mcp: BackgroundMcp,
    private readonly toolResults: BackgroundToolResults,
    private readonly attachmentCache: BackgroundAttachmentCache,
    private readonly narrative: BackgroundNarrative,
    private readonly providerRuntime: BackgroundProviderRuntime,
    private readonly systemEvents: BackgroundSystemEvents,
  ) {}

  start(): void {
    if (this.started) return;
    if (this.stopped) {
      throw new Error('BackgroundWork 已关闭，不能重新启动');
    }
    // 崩溃恢复必须先于新一轮后台任务，避免旧 running 状态与新 Worker 竞争。
    this.startupRecovery.runRequired();
    this.started = true;
    this.unsubscribeActiveTurns = this.foregroundActivity.subscribeActiveTurns(
      activeCount => {
        this.idlePolicy.recordForegroundActivity();
        if (activeCount > 0) {
          this.maintenanceAbortController?.abort(
            new DOMException('前台 Turn 已开始', 'AbortError'),
          );
        }
      },
    );
    this.initialization = Promise.resolve()
      .then(() => this.startupRecovery.runMaintenance())
      .then(async ({ memoryReady }) => {
        if (!memoryReady) return;
        await this.memory.initialize();
        this.memoryEnabled = true;
      })
      .catch((error) => {
        console.warn(
          '[memory] maintenance or initialize() failed — Memory worker disabled:',
          error,
        );
      });

    try {
      const primed = this.mcp.primeFromCache();
      if (primed > 0) {
        console.info(`[mcp] primed ${primed} tool(s) from cache`);
      }
    } catch (error) {
      console.warn('[mcp] primeFromCache() failed:', error);
    }
    this.mcpDiscovery = this.mcp.discoverUncached().catch((error) => {
      console.warn('[mcp] uncached schema discovery failed:', error);
    });

    this.ticker = createBackgroundTicker({
      intervalMs: BACKGROUND_TICK_MS,
      onTick: tickCount => this.runTick(tickCount),
    });
  }

  async shutdown(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    this.maintenanceAbortController?.abort(
      new DOMException('LocalHost 正在关闭', 'AbortError'),
    );

    // 先停止生产新任务，再等待初始化，最后依次排空 Memory 与 MCP。
    await this.ticker?.stop();
    this.ticker = null;
    this.unsubscribeActiveTurns?.();
    this.unsubscribeActiveTurns = null;
    await this.initialization;
    if (this.memoryEnabled) {
      try {
        await this.memory.drain();
      } catch (error) {
        console.warn('[memory] drain() failed during shutdown:', error);
      }
    }
    await this.mcpDiscovery;
    try {
      await this.mcp.disconnectAll();
    } catch (error) {
      console.warn('[mcp] disconnectAll() failed during shutdown:', error);
    }
  }

  private async runTick(tickCount: number): Promise<void> {
    if (this.memoryEnabled) {
      await this.memory.tick().catch((error) => {
        console.warn('[memory] background tick failed:', error);
      });
    }

    if (tickCount % CLEANER_SWEEP_EVERY === 0) {
      this.sweepToolResults();
    }
    if (tickCount % ATTACHMENT_CACHE_SWEEP_EVERY === 0) {
      await this.sweepAttachmentCache();
    }
    if (tickCount % MEMORY_DECAY_SWEEP_EVERY === 0) {
      await this.runLightMemoryMaintenance();
    }
    await this.runHeavyMemoryMaintenance();
    if (tickCount % BRIDGE_HEARTBEAT_EVERY === 0) {
      this.lastBridgeReady = await this.checkBridgeHeartbeat();
    }
  }

  private async runLightMemoryMaintenance(): Promise<void> {
    if (!this.memoryEnabled) return;
    if (!this.idlePolicy.canRun(
      this.foregroundActivity.hasActiveTurns(),
      LIGHT_MAINTENANCE_IDLE_MS,
    )) {
      return;
    }

    const controller = new AbortController();
    this.maintenanceAbortController = controller;
    try {
      const report = await this.memory.runMaintenance(
        { dryRun: false },
        controller.signal,
      );
      if (report.decayedNodes > 0 || report.decayedItems > 0) {
        console.log(
          `[memory] decay: nodes=${report.decayedNodes} `
          + `items=${report.decayedItems}`,
        );
      }
      controller.signal.throwIfAborted();
      const consolidation = await this.memory.consolidatePendingNodes(
        10,
        controller.signal,
      );
      if (consolidation.consolidated > 0 || consolidation.conflicts > 0) {
        console.log(
          `[memory] consolidation: completed=${consolidation.consolidated} `
          + `conflicts=${consolidation.conflicts}`,
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn('[memory] light maintenance failed:', error);
      }
    } finally {
      if (this.maintenanceAbortController === controller) {
        this.maintenanceAbortController = null;
      }
    }
  }

  private async runHeavyMemoryMaintenance(): Promise<void> {
    if (!this.memoryEnabled) return;
    const nowMs = Date.now();
    if (nowMs - this.lastHeavyMaintenanceAt < HEAVY_MAINTENANCE_IDLE_MS) {
      return;
    }
    if (!this.idlePolicy.canRun(
      this.foregroundActivity.hasActiveTurns(),
      HEAVY_MAINTENANCE_IDLE_MS,
      nowMs,
    )) {
      return;
    }

    this.lastHeavyMaintenanceAt = nowMs;
    const controller = new AbortController();
    this.maintenanceAbortController = controller;
    try {
      await this.sweepMemoryStorageBudget(controller.signal);
      controller.signal.throwIfAborted();
      await this.sweepMemoryEmbeddings(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (this.maintenanceAbortController === controller) {
        this.maintenanceAbortController = null;
      }
    }
  }

  private sweepToolResults(): void {
    try {
      const { deleted, freedBytes } = this.toolResults.sweep();
      if (deleted > 0) {
        console.log(
          `[tool-results] cleaner: removed ${deleted} file(s), `
          + `freed ${(freedBytes / 1024).toFixed(0)} KB`,
        );
      }
    } catch (error) {
      console.warn('[tool-results] cleaner sweep failed:', error);
    }
  }

  private async sweepAttachmentCache(): Promise<void> {
    try {
      const report = await this.attachmentCache.sweepIfIdle();
      if (report.ran && (report.deletedDerivations > 0 || report.deletedImages > 0)) {
        console.log(
          `[attachment-cache] cleaner: removed ${report.deletedDerivations} derivation(s)`
          + ` and ${report.deletedImages} image(s), `
          + `freed ${(report.freedBytes / 1024).toFixed(0)} KB`,
        );
      }
    } catch (error) {
      console.warn('[attachment-cache] cleaner sweep failed:', error);
    }
  }

  private async sweepMemoryEmbeddings(signal: AbortSignal): Promise<void> {
    if (!this.memoryEnabled) return;
    try {
      const report = await this.memory.repairStaleEmbeddings(100, signal);
      if (report.ran && (report.nodesRepaired + report.itemsRepaired > 0 || report.failed > 0)) {
        console.log(
          `[memory] embedding repair: nodes=${report.nodesRepaired} `
          + `items=${report.itemsRepaired} failed=${report.failed} `
          + `remaining=${report.remaining}`,
        );
      }
    } catch (error) {
      if (signal.aborted) return;
      console.warn('[memory] embedding repair sweep failed:', error);
    }
  }

  private async sweepMemoryStorageBudget(signal: AbortSignal): Promise<void> {
    if (!this.memoryEnabled) return;
    try {
      const report = await this.memory.enforceStorageBudget(signal);
      if (report.ran) {
        console.log(
          `[memory] storage budget: before=${report.beforeBytes} `
          + `after=${report.afterBytes} max=${report.maxBytes} `
          + `pressure=${report.pressureRemaining}`,
        );
      }
    } catch (error) {
      if (signal.aborted) return;
      console.warn('[memory] storage budget sweep failed:', error);
    }
  }

  private async checkBridgeHeartbeat(): Promise<boolean> {
    let ready = await this.narrative.isReady();
    if (!ready) {
      await this.providerRuntime.syncBridge().catch(() => undefined);
      ready = await this.narrative.isReady();
    }

    if (this.lastBridgeReady === null) {
      if (!ready) {
        console.warn('[bridge] narrative capability unavailable — degrading');
        this.systemEvents.emit({
          type: 'system_warning',
          level: 'warn',
          message: 'Narrative bridge 不可达 — narrative 模式暂时降级',
        });
      }
    } else if (!this.lastBridgeReady && ready) {
      console.log('[bridge] narrative capability recovered');
      this.systemEvents.emit({
        type: 'system_warning',
        level: 'info',
        message: 'Narrative bridge 已恢复',
      });
    } else if (this.lastBridgeReady && !ready) {
      console.warn('[bridge] narrative capability lost — degrading');
      this.systemEvents.emit({
        type: 'system_warning',
        level: 'warn',
        message: 'Narrative bridge 不可达 — narrative 模式暂时降级',
      });
    }
    return ready;
  }
}
