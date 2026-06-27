import type { SessionId, TurnId, TurnMode, EmaStreamEvent } from '@ema-agent/contracts';
import type { LlmMessage } from '@ema-agent/llm';
import { estimateTextTokens } from '@ema-agent/token';
import type { MemoryDeps } from './deps.js';
import type { PlanContext, RecallBundle, MemorySettings, CompactResult } from './types.js';
import { DEFAULT_MEMORY_SETTINGS } from './types.js';
import { EmbedService }     from './embed/service.js';
import { SessionTaskQueue } from './tasks/session-queue.js';
import { MemoryTaskRunner } from './tasks/extraction-runner.js';
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
import { buildContextMessage } from './recall/context-builder.js';
import { IndexManager }  from './vector-index/index-manager.js';
import { planRecall }    from './recall/recall-planner.js';
import { runCompaction } from './compact/compactor.js';
import { handleAfterTurn, handleForceExtract } from './extract/dispatcher.js';

export class MemoryPlanner {
  private readonly embed:    EmbedService;
  private readonly settings: MemorySettings;
  private readonly indexMgr: IndexManager;
  private readonly queue:    SessionTaskQueue;
  private readonly runner:   MemoryTaskRunner;

  constructor(
    private readonly deps: MemoryDeps,
    overrides: Partial<MemorySettings> = {},
  ) {
    this.settings = {
      ...DEFAULT_MEMORY_SETTINGS,
      ...overrides,
      triggers:    { ...DEFAULT_MEMORY_SETTINGS.triggers,    ...overrides.triggers },
      recall:      { ...DEFAULT_MEMORY_SETTINGS.recall,      ...overrides.recall },
      compaction:  { ...DEFAULT_MEMORY_SETTINGS.compaction,  ...overrides.compaction },
      maintenance: { ...DEFAULT_MEMORY_SETTINGS.maintenance, ...overrides.maintenance },
    };
    this.embed    = new EmbedService(deps.ebd, this.settings.models?.embed, this.settings.models?.rerank);
    this.indexMgr = new IndexManager(deps, this.embed);
    this.queue    = new SessionTaskQueue();
    this.runner   = new MemoryTaskRunner({
      memory:              deps,
      embed:               this.embed,
      settings:            this.settings,
      queue:               this.queue,
      getNodesIndex:       () => this.indexMgr.nodesIndex,
      getItemsIndex:       () => this.indexMgr.itemsIndex,
      getSessionOverrides: (sid) => this.getSessionOverrides(sid),
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
      (sid) => this.getSessionOverrides(sid),
      ctx,
    );
  }

  // ── Combined beforeLlm orchestration ────────────────────────────────────────

  async applyToBeforeLlm(args: {
    sessionId:          SessionId;
    turnId:             TurnId;
    mode:               TurnMode;
    userInput:          string;
    messages:           LlmMessage[];
    modelContextWindow: number;
    providerId?:        string;
    compactionModel?:   string;
    recentFiles?:       ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
    signal?:            AbortSignal;
    emit?:              (event: EmaStreamEvent) => void;
  }): Promise<{
    messages:      LlmMessage[];
    compactionRan: boolean;
    microCleared:  number;
    recallSummary: { layer0: number; layer1: boolean; layer2: number };
    tokenEstimate: number;
  }> {
    if (!this.settings.enabled) {
      return { messages: args.messages, compactionRan: false, microCleared: 0, recallSummary: { layer0: 0, layer1: false, layer2: 0 }, tokenEstimate: 0 };
    }

    const compactRes = await this.compact({
      sessionId:          args.sessionId,
      turnId:             args.turnId,
      mode:               args.mode,
      messages:           args.messages,
      modelContextWindow: args.modelContextWindow,
      providerId:         args.providerId,
      model:              args.compactionModel,
      recentFiles:        args.recentFiles,
      signal:             args.signal,
      emit:               args.emit,
    });
    let working = compactRes.messages;

    const bundle = await this.plan({
      sessionId: args.sessionId,
      turnId:    args.turnId,
      mode:      args.mode,
      userInput: args.userInput,
      signal:    args.signal,
      emit:      args.emit,
    });

    const ctxMsg = buildContextMessage(bundle);
    let tokenEstimate = 0;
    if (ctxMsg) {
      tokenEstimate = typeof ctxMsg.content === 'string' ? estimateTextTokens(ctxMsg.content) : 0;
      const lastIdx    = working.length - 1;
      const lastIsUser = lastIdx >= 0 && working[lastIdx]?.role === 'user';
      working = lastIsUser
        ? [...working.slice(0, lastIdx), ctxMsg, working[lastIdx]!]
        : [...working, ctxMsg];
    }

    return {
      messages:      working,
      compactionRan: compactRes.macroRan,
      microCleared:  compactRes.microCleared,
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
    return collectStats(this.deps, { nodesIndex: this.indexMgr.nodesIndex, itemsIndex: this.indexMgr.itemsIndex }, this.embed.currentProviderId() ?? null);
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
    mode:          TurnMode;
    userText:      string;
    assistantText: string;
  }): Promise<void> {
    return handleAfterTurn(this.deps, this.settings, this.runner, (sid) => this.getSessionOverrides(sid), ctx);
  }

  async forceExtract(sessionId: SessionId, mode: TurnMode): Promise<void> {
    return handleForceExtract(this.runner, sessionId, mode);
  }

  async tick():  Promise<void> { await this.runner.tick(); }
  async drain(): Promise<void> { await this.queue.drainAll(); }

  runStartupRecovery(): RecoveryReport { return doStartupRecovery(this.deps, this.embed); }

  // ── Compaction (also called directly from tests / maintenance) ──────────────

  async compact(args: {
    sessionId:           SessionId;
    turnId:              TurnId;
    mode:                TurnMode;
    messages:            LlmMessage[];
    modelContextWindow:  number;
    providerId?:         string;
    model?:              string;
    recentFiles?:        ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
    signal?:             AbortSignal;
    emit?:               (event: EmaStreamEvent) => void;
  }): Promise<CompactResult> {
    return runCompaction(this.deps, this.settings, (sid) => this.getSessionOverrides(sid), args);
  }
}
