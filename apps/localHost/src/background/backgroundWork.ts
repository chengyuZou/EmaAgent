// 管理 LocalHost 启动后常驻的恢复、维护、Bridge 探测与有序关闭。

import type { AttachmentCacheMaintenance } from '@ema-agent/attachment';
import type { McpRegistry } from '@ema-agent/mcp';
import type { MemoryPlanner } from '@ema-agent/memory';
import type { NarrativeClient } from '@ema-agent/narrative';
import type { ToolResultCleaner } from '@ema-agent/tools';
import type { SystemEventBus } from '../sse/system-bus.js';
import type { ProviderRuntimeFacade } from '../wiring/provider-runtime.js';
import {
  createBackgroundTicker,
  type BackgroundTicker,
} from './backgroundTicker.js';
import type { StartupRecovery } from './startupRecovery.js';

const BACKGROUND_TICK_MS = 5_000;
const CLEANER_SWEEP_EVERY = 360;
const ATTACHMENT_CACHE_SWEEP_EVERY = 360;
const BRIDGE_HEARTBEAT_EVERY = 12;
const EMBEDDING_REPAIR_SWEEP_EVERY = 360;

type BackgroundMemory = Pick<MemoryPlanner, 'initialize' | 'tick' | 'drain' | 'repairStaleEmbeddings'>;
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
  private started = false;
  private stopped = false;

  constructor(
    private readonly startupRecovery: Pick<
      StartupRecovery,
      'runRequired' | 'runMaintenance'
    >,
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

    // 先停止生产新任务，再等待初始化，最后依次排空 Memory 与 MCP。
    await this.ticker?.stop();
    this.ticker = null;
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
    if (tickCount % EMBEDDING_REPAIR_SWEEP_EVERY === 0) {
      await this.sweepMemoryEmbeddings();
    }
    if (tickCount % BRIDGE_HEARTBEAT_EVERY === 0) {
      this.lastBridgeReady = await this.checkBridgeHeartbeat();
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

  private async sweepMemoryEmbeddings(): Promise<void> {
    if (!this.memoryEnabled) return;
    try {
      const report = await this.memory.repairStaleEmbeddings();
      if (report.ran && (report.nodesRepaired + report.itemsRepaired > 0 || report.failed > 0)) {
        console.log(
          `[memory] embedding repair: nodes=${report.nodesRepaired} `
          + `items=${report.itemsRepaired} failed=${report.failed} `
          + `remaining=${report.remaining}`,
        );
      }
    } catch (error) {
      console.warn('[memory] embedding repair sweep failed:', error);
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
