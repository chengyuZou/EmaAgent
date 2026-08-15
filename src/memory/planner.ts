// 组织长期记忆的检索、提取、维护和后台修复，并向编排层提供窄入口。
import type { ContextContributionRequest } from '@ema-agent/context';
import { estimateTextTokens } from '@ema-agent/token';
import type { MemoryDeps } from './deps.js';
import type { MemoryEvent } from './events.js';
import type {
  MemoryRecallView,
  PlanContext,
  RecallBundle,
  MemorySettings,
} from './types.js';
import { DEFAULT_MEMORY_SETTINGS } from './types.js';
import {
  DEFAULT_MEMORY_MAINTENANCE_SETTINGS,
  DEFAULT_MEMORY_STORAGE_SETTINGS,
  type MemoryUserSettingsSnapshot,
} from './settings.js';
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
  runMaintenance,
  type MaintenanceOptions, type MaintenanceReport,
} from './maintenance/decay.js';
import {
  repairStaleEmbeddings,
  type EmbeddingRepairReport,
} from './maintenance/embeddingRepair.js';
import {
  consolidatePendingNodes as consolidatePendingMemoryNodes,
  type ConsolidationReport,
} from './consolidation/consolidatePendingNodes.js';
import {
  enforceMemoryStorageBudget,
  type MemoryStorageBudgetReport,
} from './maintenance/storageBudget.js';
import {
  runStartupRecovery as doStartupRecovery,
  type RecoveryReport,
} from './tasks/recovery.js';
import { buildMemoryContextContribution } from './recall/context-builder.js';
import { IndexManager }  from './vector-index/index-manager.js';
import { planRecall }    from './recall/recall-planner.js';
import { recordTurnForExtraction, handleForceExtract } from './extract/dispatcher.js';
import {
  cleanupSessionMemoryReferences,
} from './sessionCleanup.js';

export class MemoryPlanner {
  private readonly embed:    EmbedService;
  private readonly settings: MemorySettings;
  private readonly indexMgr: IndexManager;
  private readonly queue:    SessionTaskQueue;
  private readonly runner:   MemoryTaskRunner;
  private readonly commitCoordinator: MemoryCommitCoordinator;
  private readonly readUserSettings: () => MemoryUserSettingsSnapshot;

  constructor(
    private readonly deps: MemoryDeps,
    overrides: Partial<MemorySettings> = {},
    readUserSettings: () => MemoryUserSettingsSnapshot = () => ({
      models: {},
      maintenance: DEFAULT_MEMORY_MAINTENANCE_SETTINGS,
      storage: DEFAULT_MEMORY_STORAGE_SETTINGS,
    }),
  ) {
    this.settings = {
      ...DEFAULT_MEMORY_SETTINGS,
      ...overrides,
      triggers:    { ...DEFAULT_MEMORY_SETTINGS.triggers,    ...overrides.triggers },
      recall:      { ...DEFAULT_MEMORY_SETTINGS.recall,      ...overrides.recall },
      maintenance: { ...DEFAULT_MEMORY_SETTINGS.maintenance, ...overrides.maintenance },
    };
    this.readUserSettings = readUserSettings;
    this.embed = new EmbedService(
      deps.embedRuntime,
      deps.rerankRuntime,
      () => this.readUserSettings().models,
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
      refreshIndexes:      () => this.indexMgr.refreshIndexes(),
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
    await this.indexMgr.initialize();
    return planRecall(
      this.deps, this.embed, this.settings,
      this.indexMgr.nodesIndex, this.indexMgr.itemsIndex,
      this.indexMgr.currentSpaceId(),
      this.commitCoordinator,
      (sid) => this.getSessionOverrides(sid),
      ctx,
    );
  }

  // ── LLM recall view ─────────────────────────────────────────────────────────

  /** 检索并渲染当前 Turn 的临时记忆贡献，不读取或改写模型消息数组。 */
  async prepareRecallContribution(
    args: ContextContributionRequest<MemoryEvent>,
  ): Promise<MemoryRecallView> {
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

  getSessionOverrides(sessionId: string): ResolvedSessionOverrides {
    return readOverrides(this.deps.memorySessionState, sessionId);
  }

  setSessionOverrides(sessionId: string, overrides: MemorySessionOverrides): void {
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

  async runMaintenance(
    opts: Partial<MaintenanceOptions> = {},
    signal?: AbortSignal,
  ): Promise<MaintenanceReport> {
    const maintenance = this.readUserSettings().maintenance;
    return runMaintenance(this.deps, {
      decayAfterDays: opts.decayAfterDays ?? maintenance.decayAfterDays,
      decayAmount:    opts.decayAmount    ?? maintenance.decayAmount,
      decayItems:     opts.decayItems     ?? true,
      dryRun:         opts.dryRun         ?? true,
      nowMs:          opts.nowMs          ?? Date.now(),
    }, this.commitCoordinator, signal);
  }

  /** 归并全局节点的待处理证据；模型计算在锁外，提交使用单节点 CAS 事务。 */
  async consolidatePendingNodes(
    maxNodes = 10,
    signal?: AbortSignal,
  ): Promise<ConsolidationReport> {
    await this.indexMgr.initialize();
    return consolidatePendingMemoryNodes({
      memory: this.deps,
      embed: this.embed,
      nodesIndex: this.indexMgr.nodesIndex,
      indexSpaceId: this.indexMgr.currentSpaceId(),
      commitCoordinator: this.commitCoordinator,
      refreshIndexes: () => this.indexMgr.refreshIndexes(),
    }, {
      maxNodes,
      signal,
    });
  }

  async deleteNode(nodeId: string): Promise<void> {
    await this.commitCoordinator.runExclusive(() =>
      this.deps.runProfileTransaction(() => this.deps.nodes.delete(nodeId)),
    );
    this.indexMgr.removeNode(nodeId);
  }

  async deleteItem(itemId: string): Promise<void> {
    await this.commitCoordinator.runExclusive(() =>
      this.deps.runProfileTransaction(() => this.deps.items.delete(itemId)),
    );
    this.indexMgr.removeItem(itemId);
  }

  /** 换 embed 模型后按批修复 stale/缺失向量；进度隐式推进，断电续扫。 */
  async repairStaleEmbeddings(
    batchSize = 100,
    signal?: AbortSignal,
  ): Promise<EmbeddingRepairReport> {
    await this.indexMgr.initialize();
    return repairStaleEmbeddings(this.deps, this.embed, {
      batchSize,
      nodesIndex: this.indexMgr.nodesIndex,
      itemsIndex: this.indexMgr.itemsIndex,
      indexSpaceId: this.indexMgr.currentSpaceId(),
      commitCoordinator: this.commitCoordinator,
      refreshIndexes: () => this.indexMgr.refreshIndexes(),
      signal,
    });
  }

  /** 超预算时按过期、零重要度正文、冷向量顺序降压。 */
  async enforceStorageBudget(signal?: AbortSignal): Promise<MemoryStorageBudgetReport> {
    const settings = this.readUserSettings();
    return enforceMemoryStorageBudget(this.deps, settings, {
      commitCoordinator: this.commitCoordinator,
      removeNodeFromIndex: id => this.indexMgr.removeNode(id),
      removeItemFromIndex: id => this.indexMgr.removeItem(id),
      refreshIndexes: () => this.indexMgr.refreshIndexes(),
      signal,
    });
  }

  // ── Background work ─────────────────────────────────────────────────────────

  async recordTurnForExtraction(ctx: {
    sessionId:     string;
    turnId:        string;
    executionProfile: ContextContributionRequest['executionProfile'];
    userText:      string;
    assistantText: string;
  }): Promise<void> {
    return recordTurnForExtraction(this.deps, this.settings, this.runner, (sid) => this.getSessionOverrides(sid), ctx);
  }

  async forceExtract(sessionId: string, executionProfile: ContextContributionRequest['executionProfile']): Promise<void> {
    return handleForceExtract(this.runner, sessionId, executionProfile);
  }

  async tick():  Promise<void> { await this.runner.tick(); }
  async drain(): Promise<void> {
    await this.runner.shutdown();
    await this.commitCoordinator.drain();
  }

  /** Session 删除前停止新提取、撤销任务租约并取消事务外模型调用。 */
  async beforeSessionDelete(sessionId: string): Promise<void> {
    await this.runner.cancelSession(sessionId);
  }

  /** Data DB 删除成功后清理 Profile DB 软引用；长期 Memory 正文继续保留。 */
  async afterSessionDelete(sessionId: string): Promise<void> {
    try {
      await this.commitCoordinator.runExclusive(() =>
        cleanupSessionMemoryReferences(this.deps, sessionId),
      );
    } finally {
      this.runner.releaseSession(sessionId);
    }
  }

  /** Session 删除在 Data DB 提交前失败时恢复 Extraction 入口。 */
  cancelSessionDelete(sessionId: string): void {
    this.runner.releaseSession(sessionId);
  }

  runStartupRecovery(): RecoveryReport { return doStartupRecovery(this.deps, this.embed); }

}
