// 组织通用记忆的检索、写入和上下文压缩，并通过 Memory Facade 暴露给编排层。
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { ContextContributionRequest } from '@ema-agent/context';
import { estimateTextTokens } from '@ema-agent/token';
import type { MemoryDeps } from './deps.js';
import type {
  MemoryRecallView,
  PlanContext,
  RecallBundle,
  MemorySettings,
} from './types.js';
import { DEFAULT_MEMORY_SETTINGS } from './types.js';
import { EmbedService }     from './embed/service.js';
import { SessionTaskQueue } from './tasks/session-queue.js';
import { MemoryTaskRunner } from './tasks/extraction-runner.js';
import { MemoryCommitCoordinator } from './tasks/commit-coordinator.js';
import {
  readOverrides, writeOverrides,
  type MemorySessionOverrides, type ResolvedSessionOverrides,
} from './maintenance/overrides.js';
import { collectStats, type MemoryStats } from './maintenance/stats.js';
import {
  browseNodes, browseItems, browseEdgesForNodes,
  type BrowseNodesOptions, type BrowseItemsOptions,
} from './maintenance/browse.js';
import {
  runMaintenance, deleteNode, deleteItem, hardDeleteZeroImportance,
  type MaintenanceOptions, type MaintenanceReport,
} from './maintenance/decay.js';
import {
  runStartupRecovery as doStartupRecovery,
  type RecoveryReport,
} from './tasks/recovery.js';
import { buildMemoryContextContribution } from './recall/context-builder.js';
import { recallSessionNote } from './recall/layer1-notes.js';
import { IndexManager }  from './vector-index/index-manager.js';
import { planRecall }    from './recall/recall-planner.js';
import { handleAfterTurn, handleForceExtract } from './extract/dispatcher.js';

export class MemoryPlanner {
  private readonly embed:    EmbedService;
  private readonly settings: MemorySettings;
  private readonly indexMgr: IndexManager;
  private readonly queue:    SessionTaskQueue;
  private readonly runner:   MemoryTaskRunner;
  private readonly commitCoordinator: MemoryCommitCoordinator;

  constructor(
    private readonly deps: MemoryDeps,
    overrides: Partial<MemorySettings> = {},
  ) {
    this.settings = {
      ...DEFAULT_MEMORY_SETTINGS,
      ...overrides,
      triggers:    { ...DEFAULT_MEMORY_SETTINGS.triggers,    ...overrides.triggers },
      recall:      { ...DEFAULT_MEMORY_SETTINGS.recall,      ...overrides.recall },
      maintenance: { ...DEFAULT_MEMORY_SETTINGS.maintenance, ...overrides.maintenance },
    };
    this.embed = new EmbedService(
      deps.embedRuntime,
      deps.rerankRuntime,
      this.settings.models?.embed,
      this.settings.models?.rerank,
    );
    this.indexMgr = new IndexManager(deps, this.embed);
    this.queue    = new SessionTaskQueue();
    this.commitCoordinator = new MemoryCommitCoordinator();
    this.runner   = new MemoryTaskRunner({
      memory:              deps,
      embed:               this.embed,
      settings:            this.settings,
      queue:               this.queue,
      getNodesIndex:       () => this.indexMgr.nodesIndex,
      getItemsIndex:       () => this.indexMgr.itemsIndex,
      getIndexSpaceId:     () => this.indexMgr.currentSpaceId(),
      getSessionOverrides: (sid) => this.getSessionOverrides(sid),
      commitCoordinator:   this.commitCoordinator,
    });
  }

  getSettings(): MemorySettings { return this.settings; }

  // ── Initialization ──────────────────────────────────────────────────────────

  async initialize(): Promise<{ nodes: number; items: number; backend: string | null }> {
    return this.indexMgr.initialize();
  }

  async refreshIndexes(): Promise<void> {
    return this.indexMgr.refreshIndexes();
  }

  // ── Recall ──────────────────────────────────────────────────────────────────

  async plan(ctx: PlanContext): Promise<RecallBundle> {
    return planRecall(
      this.deps, this.embed, this.settings,
      this.indexMgr.nodesIndex, this.indexMgr.itemsIndex,
      this.indexMgr.currentSpaceId(),
      (sid) => this.getSessionOverrides(sid),
      ctx,
    );
  }

  /** Context 压缩恢复只读取渲染后的 L1 Note，不接触 Memory 内部 Repo。 */
  loadSessionNote(sessionId: SessionId): string | null {
    return recallSessionNote(this.deps, sessionId);
  }

  // ── LLM recall view ─────────────────────────────────────────────────────────

  /** 检索并渲染当前 Turn 的临时记忆贡献，不读取或改写模型消息数组。 */
  async prepareRecallContribution(args: ContextContributionRequest): Promise<MemoryRecallView> {
    if (!this.settings.enabled) {
      return {
        contribution: null,
        recallSummary: { layer0: 0, layer1: false, layer2: 0 },
        tokenEstimate: 0,
      };
    }

    const bundle = await this.plan({
      sessionId: args.sessionId,
      turnId:    args.turnId,
      executionProfile: args.executionProfile,
      userInput: args.userInput,
      signal:    args.signal,
      emit:      args.emit,
    });

    const contribution = buildMemoryContextContribution(bundle);
    const content = contribution?.message.content;
    const tokenEstimate = typeof content === 'string' ? estimateTextTokens(content) : 0;

    return {
      contribution,
      tokenEstimate,
      recallSummary: {
        layer0: bundle.layer0?.nodes.length ?? 0,
        layer1: bundle.layer1 !== null,
        layer2: (bundle.layer2?.currentMode.length ?? 0) + (bundle.layer2?.otherModes.length ?? 0),
      },
    };
  }

  // ── Index mutation hooks ─────────────────────────────────────────────────────

  indexUpsertNode(id: string, vec: Float32Array): void { this.indexMgr.upsertNode(id, vec); }
  indexRemoveNode(id: string): void                    { this.indexMgr.removeNode(id); }
  indexUpsertItem(id: string, vec: Float32Array): void { this.indexMgr.upsertItem(id, vec); }
  indexRemoveItem(id: string): void                    { this.indexMgr.removeItem(id); }

  indexStats(): { nodes: { size: number; backend: string } | null; items: { size: number; backend: string } | null } {
    return this.indexMgr.stats();
  }

  // ── Per-session overrides ───────────────────────────────────────────────────

  getSessionOverrides(sessionId: SessionId): ResolvedSessionOverrides {
    return readOverrides(this.deps.memorySessionState, sessionId);
  }

  setSessionOverrides(sessionId: SessionId, overrides: MemorySessionOverrides): void {
    writeOverrides(this.deps.memorySessionState, sessionId, overrides);
  }

  // ── Stats / Inspection ──────────────────────────────────────────────────────

  getStats(): MemoryStats {
    return collectStats(this.deps, { nodesIndex: this.indexMgr.nodesIndex, itemsIndex: this.indexMgr.itemsIndex }, this.indexMgr.currentSpaceId());
  }

  listNodes(opts?: BrowseNodesOptions)          { return browseNodes(this.deps, opts); }
  listItems(opts?: BrowseItemsOptions)          { return browseItems(this.deps, opts); }
  listEdgesForNodes(nodeIds: string[])          { return browseEdgesForNodes(this.deps, nodeIds); }

  // ── Maintenance ─────────────────────────────────────────────────────────────

  runMaintenance(opts: Partial<MaintenanceOptions> = {}): MaintenanceReport {
    return runMaintenance(this.deps, {
      decayAfterDays: opts.decayAfterDays ?? this.settings.maintenance.decayAfterDays,
      decayAmount:    opts.decayAmount    ?? this.settings.maintenance.decayAmount,
      decayItems:     opts.decayItems     ?? true,
      dryRun:         opts.dryRun         ?? true,
      nowMs:          opts.nowMs          ?? Date.now(),
    });
  }

  deleteNode(nodeId: string): void {
    deleteNode(this.deps, nodeId);
    this.indexMgr.removeNode(nodeId);
  }

  deleteItem(itemId: string): void {
    deleteItem(this.deps, itemId);
    this.indexMgr.removeItem(itemId);
  }

  hardDeleteZeroImportance(thresholdDays: number) {
    return hardDeleteZeroImportance(this.deps, thresholdDays);
  }

  // ── Background work ─────────────────────────────────────────────────────────

  async afterTurn(ctx: {
    sessionId:     SessionId;
    turnId:        string;
    executionProfile: ContextContributionRequest['executionProfile'];
    userText:      string;
    assistantText: string;
  }): Promise<void> {
    return handleAfterTurn(this.deps, this.settings, this.runner, (sid) => this.getSessionOverrides(sid), ctx);
  }

  async forceExtract(sessionId: SessionId, executionProfile: ContextContributionRequest['executionProfile']): Promise<void> {
    return handleForceExtract(this.runner, sessionId, executionProfile);
  }

  async tick():  Promise<void> { await this.runner.tick(); }
  async drain(): Promise<void> { await this.runner.shutdown(); }

  runStartupRecovery(): RecoveryReport { return doStartupRecovery(this.deps, this.embed); }

}
