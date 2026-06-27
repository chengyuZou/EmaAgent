import type { SessionId, TurnId, TurnMode, EmaStreamEvent } from '@ema-agent/contracts';
import type { LlmMessage } from '@ema-agent/llm';
import { bestEffort, bestEffortAsync } from './observability.js';
import type { MemoryDeps } from './deps.js';
import type {
  PlanContext, RecallBundle, MemorySettings, AlreadySurfaced, CompactResult,
  GraphRecallResult, EpisodicRecallResult,
} from './types.js';
import { DEFAULT_MEMORY_SETTINGS } from './types.js';
import { EmbedService }     from './embed/service.js';
import { recallGraph }      from './recall/layer0-graph.js';
import { recallSessionNote } from './recall/layer1-notes.js';
import { recallEpisodic }   from './recall/layer2-episodic.js';
import { createVectorIndex } from './index/factory.js';
import { rebuildNodesIndex, rebuildItemsIndex } from './index/builder.js';
import type { VectorIndex } from './index/vector-index.js';
import {
  appendPending, readPending, shouldExtract, buildFragmentsFromTurn,
} from './extract/pending.js';
import { SessionTaskQueue } from './tasks/session-queue.js';
import { MemoryTaskRunner } from './tasks/runner.js';
import { microCompact } from './compact/micro.js';
import { runMacroCompaction } from './compact/macro.js';
import { buildPostCompactRestore } from './compact/restore.js';
import { estimateMessagesTokens, estimateTextTokens } from '@ema-agent/token';
import {
  readOverrides, writeOverrides,
  type MemorySessionOverrides, type ResolvedSessionOverrides,
} from './maintenance/overrides.js';
import { collectStats, type MemoryStats } from './maintenance/stats.js';
import {
  browseNodes, browseItems, browseEdgesForNodes,
  type BrowseNodesOptions, type BrowseItemsOptions,
} from './maintenance/inspection.js';
import {
  runMaintenance, deleteNode, deleteItem, hardDeleteZeroImportance,
  type MaintenanceOptions, type MaintenanceReport,
} from './maintenance/decay.js';
import {
  runStartupRecovery as doStartupRecovery,
  type RecoveryReport,
} from './tasks/recovery.js';

// ── alreadySurfaced bookkeeping ──────────────────────────────────────────────

const SURFACED_TTL_MS = 1000 * 60 * 60 * 6;   // 6 hours

function loadSurfaced(raw: Record<string, unknown>): AlreadySurfaced {
  const entry = raw as Partial<AlreadySurfaced>;
  if (!entry.updatedAt) return { nodes: [], items: [], updatedAt: Date.now() };
  if (Date.now() - entry.updatedAt > SURFACED_TTL_MS) {
    return { nodes: [], items: [], updatedAt: Date.now() };
  }
  return {
    nodes:     Array.isArray(entry.nodes) ? entry.nodes.slice(-200) : [],
    items:     Array.isArray(entry.items) ? entry.items.slice(-200) : [],
    updatedAt: entry.updatedAt,
  };
}

// ── MemoryPlanner Facade ─────────────────────────────────────────────────────

/**
 * The single entry point into the memory subsystem.
 *
 *   initialize()     — startup: build VectorIndexes from DB.
 *   plan(ctx)        — beforeLlm: assemble the 3-layer RecallBundle.
 *   afterTurn(ctx)   — onTurnEnd: append turn to pending_fragments (Round 3).
 *   compact(ctx)     — beforeLlm pre-send: macro/micro compaction (Round 4).
 *
 * MemoryPlanner is the only thing the orchestrator wires for memory; hook
 * registrations will live in `registerMemoryHooks()` (Round 4).
 */
export class MemoryPlanner {
  private readonly embed: EmbedService;
  private readonly settings: MemorySettings;

  // Vector indexes — built lazily in initialize().
  // null when embed provider is missing or the dim is unknown.
  private nodesIndex: VectorIndex | null = null;
  private itemsIndex: VectorIndex | null = null;
  private indexProviderId: string | null = null;
  private indexDim:        number | null = null;

  // Background work
  private readonly queue:  SessionTaskQueue;
  private readonly runner: MemoryTaskRunner;

  constructor(
    private readonly deps: MemoryDeps,
    overrides: Partial<MemorySettings> = {},
  ) {
    this.embed = new EmbedService(deps.ebd);
    this.settings = {
      ...DEFAULT_MEMORY_SETTINGS,
      ...overrides,
      triggers:   { ...DEFAULT_MEMORY_SETTINGS.triggers,   ...overrides.triggers },
      recall:     { ...DEFAULT_MEMORY_SETTINGS.recall,     ...overrides.recall },
      compaction: { ...DEFAULT_MEMORY_SETTINGS.compaction, ...overrides.compaction },
      maintenance: { ...DEFAULT_MEMORY_SETTINGS.maintenance, ...overrides.maintenance },
    };

    this.queue  = new SessionTaskQueue();
    this.runner = new MemoryTaskRunner({
      memory:              deps,
      embed:               this.embed,
      settings:            this.settings,
      queue:               this.queue,
      getNodesIndex:       () => this.nodesIndex,
      getItemsIndex:       () => this.itemsIndex,
      getSessionOverrides: (sid) => this.getSessionOverrides(sid),
    });
  }

  getSettings(): MemorySettings { return this.settings; }

  // ── Initialization ──────────────────────────────────────────────────────────

  /**
   * Build the vector indexes from existing DB rows. Idempotent — calling
   * twice is a no-op the second time (use refreshIndexes() to force rebuild
   * after provider change).
   *
   * Safe to call even when no embed provider is configured: indexes simply
   * stay `null` and the planner falls back to heuristic recall.
   */
  async initialize(): Promise<{ nodes: number; items: number; backend: string | null }> {
    if (this.nodesIndex || this.itemsIndex) {
      return {
        nodes:   this.nodesIndex?.size() ?? 0,
        items:   this.itemsIndex?.size() ?? 0,
        backend: this.nodesIndex?.backend ?? this.itemsIndex?.backend ?? null,
      };
    }

    const providerId = this.embed.currentProviderId();
    if (!providerId) return { nodes: 0, items: 0, backend: null };

    const model = this.deps.ebd.defaultEmbedModelFor(providerId);
    if (!model) return { nodes: 0, items: 0, backend: null };

    const dim = this.deps.getEmbedDim(model);
    if (!dim) return { nodes: 0, items: 0, backend: null };

    const t0 = Date.now();
    this.indexProviderId = providerId;
    this.indexDim        = dim;
    this.nodesIndex      = await createVectorIndex(dim);
    this.itemsIndex      = await createVectorIndex(dim);

    const nodes = rebuildNodesIndex(this.nodesIndex, this.deps.nodes, model);
    const items = rebuildItemsIndex(this.itemsIndex, this.deps.items, model);

    this.deps.emit?.({
      type:       'memory_index_rebuilt',
      backend:    this.nodesIndex.backend,
      nodes,
      items,
      durationMs: Date.now() - t0,
    });

    return { nodes, items, backend: this.nodesIndex.backend };
  }

  /** Drop + rebuild indexes — called when embed provider changes at runtime. */
  async refreshIndexes(): Promise<void> {
    this.nodesIndex = null;
    this.itemsIndex = null;
    this.indexProviderId = null;
    this.indexDim = null;
    await this.initialize();
  }

  // ── Recall ──────────────────────────────────────────────────────────────────

  /**
   * Assemble the per-turn recall bundle for injection.
   * Safe to call even when memory.enabled = false (returns all-null bundle).
   *
   * Failure mode: any sub-recall throws ⇒ swallowed and replaced with null.
   * Memory is best-effort; never block a turn because recall hiccupped.
   */
  async plan(ctx: PlanContext): Promise<RecallBundle> {
    if (!this.settings.enabled) {
      emitRecallLayer(ctx, 'layer0', {
        status: 'skipped',
        itemCount: 0,
        tokenEstimate: 0,
        durationMs: 0,
        skippedReason: 'memory_disabled',
      });
      emitRecallLayer(ctx, 'layer1', {
        status: 'skipped',
        itemCount: 0,
        tokenEstimate: 0,
        durationMs: 0,
        skippedReason: 'memory_disabled',
      });
      emitRecallLayer(ctx, 'layer2', {
        status: 'skipped',
        itemCount: 0,
        tokenEstimate: 0,
        durationMs: 0,
        skippedReason: 'memory_disabled',
      });
      return { layer0: null, layer1: null, layer2: null };
    }

    const overrides = this.getSessionOverrides(ctx.sessionId);
    const surfaced = this.loadAlreadySurfaced(ctx.sessionId);

    const embedded = this.embed.isAvailable()
      ? await this.safeEmbedQuery(ctx.userInput)
      : null;
    const queryVec = embedded?.queryVec ?? null;
    const queryEmbed = embedded?.embedded ?? null;

    let layer0: RecallBundle['layer0'] = null;
    let layer1: RecallBundle['layer1'] = null;
    let layer2: RecallBundle['layer2'] = null;

    const layer0Task = async (): Promise<void> => {
      const t0 = Date.now();
      if (!overrides.layer0) {
        emitRecallLayer(ctx, 'layer0', {
          status: 'skipped',
          itemCount: 0,
          tokenEstimate: 0,
          durationMs: Date.now() - t0,
          skippedReason: 'layer_disabled',
        });
        return;
      }
      if (!queryVec || !queryEmbed) {
        emitRecallLayer(ctx, 'layer0', {
          status: 'skipped',
          itemCount: 0,
          tokenEstimate: 0,
          durationMs: Date.now() - t0,
          skippedReason: 'embedding_unavailable',
        });
        return;
      }

      try {
        layer0 = recallGraph(this.deps, {
          queryVec,
          queryEmbed,
          index: this.nodesIndex,
          alreadySurfaced: new Set(surfaced.nodes),
          settings: this.settings,
        });
        if (this.settings.recall.useReranker && layer0.nodes.length > 1) {
          layer0 = await this.rerankLayer0(ctx.userInput, layer0, ctx.signal);
        }
        emitRecallLayer(ctx, 'layer0', {
          status: 'succeeded',
          itemCount: layer0.nodes.length,
          tokenEstimate: estimateGraphRecallTokens(layer0),
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        layer0 = null;
        emitRecallLayer(ctx, 'layer0', {
          status: 'failed',
          itemCount: 0,
          tokenEstimate: 0,
          durationMs: Date.now() - t0,
          error: errorMessage(err),
        });
      }
    };

    const layer1Task = async (): Promise<void> => {
      const t0 = Date.now();
      if (!overrides.layer1) {
        emitRecallLayer(ctx, 'layer1', {
          status: 'skipped',
          itemCount: 0,
          tokenEstimate: 0,
          durationMs: Date.now() - t0,
          skippedReason: 'layer_disabled',
        });
        return;
      }

      try {
        layer1 = recallSessionNote(this.deps, ctx.sessionId);
        emitRecallLayer(ctx, 'layer1', {
          status: 'succeeded',
          itemCount: layer1 ? 1 : 0,
          tokenEstimate: layer1 ? estimateTextTokens(layer1) : 0,
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        layer1 = null;
        emitRecallLayer(ctx, 'layer1', {
          status: 'failed',
          itemCount: 0,
          tokenEstimate: 0,
          durationMs: Date.now() - t0,
          error: errorMessage(err),
        });
      }
    };

    const layer2Task = async (): Promise<void> => {
      const t0 = Date.now();
      if (!overrides.layer2) {
        emitRecallLayer(ctx, 'layer2', {
          status: 'skipped',
          itemCount: 0,
          tokenEstimate: 0,
          durationMs: Date.now() - t0,
          skippedReason: 'layer_disabled',
        });
        return;
      }

      try {
        const mode = ctx.mode === 'narrative' ? 'narrative' : ctx.mode;
        layer2 = await recallEpisodic(this.deps, {
          query: ctx.userInput,
          queryVec,
          queryEmbed,
          index: this.itemsIndex,
          mode,
          alreadySurfaced: new Set(surfaced.items),
          settings: this.settings,
        });
        if (this.settings.recall.useReranker &&
            (layer2.currentMode.length + layer2.otherModes.length) > 1) {
          layer2 = await this.rerankEpisodic(ctx.userInput, layer2, ctx.signal);
        }
        emitRecallLayer(ctx, 'layer2', {
          status: 'succeeded',
          itemCount: countEpisodicItems(layer2),
          tokenEstimate: estimateEpisodicRecallTokens(layer2),
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        layer2 = null;
        emitRecallLayer(ctx, 'layer2', {
          status: 'failed',
          itemCount: 0,
          tokenEstimate: 0,
          durationMs: Date.now() - t0,
          error: errorMessage(err),
        });
      }
    };

    await Promise.allSettled([layer0Task(), layer1Task(), layer2Task()]);

    this.recordSurfaced(ctx.sessionId, surfaced, { layer0, layer2 });

    return { layer0, layer1, layer2 };
  }

  // ── Single hook entry point ─────────────────────────────────────────────────

  /**
   * Combined operation for the beforeLlm hook:
   *   1. Token-budget check → maybe compact
   *   2. Recall via plan()
   *   3. Inject a single kind='context' message just before the LAST user turn
   *
   * Returns the new messages array. Caller (the hook) replaces payload.messages
   * with this result.
   */
  async applyToBeforeLlm(args: {
    sessionId:          SessionId;
    turnId:             TurnId;
    mode:               TurnMode;
    userInput:          string;
    messages:           LlmMessage[];
    modelContextWindow: number;
    /** Current turn's provider (from frontend picker). Forwarded to compaction. */
    providerId?:        string;
    /** Current turn's model. Forwarded to compaction. */
    compactionModel?:   string;
    recentFiles?:       ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
    signal?:            AbortSignal;
    emit?:              (event: EmaStreamEvent) => void;
  }): Promise<{
    messages:        LlmMessage[];
    compactionRan:   boolean;
    microCleared:    number;
    recallSummary:   { layer0: number; layer1: boolean; layer2: number };
    tokenEstimate:   number;
  }> {
    if (!this.settings.enabled) {
      return {
        messages:      args.messages,
        compactionRan: false,
        microCleared:  0,
        recallSummary: { layer0: 0, layer1: false, layer2: 0 },
        tokenEstimate: 0,
      };
    }

    // 1. Compact — uses the current turn's (providerId, model) for the
    //    summarisation LLM call. Falls back to LlmRouter defaults when the
    //    hook meta doesn't carry model info (legacy / background tasks).
    const compactRes = await this.compact({
      sessionId:           args.sessionId,
      turnId:              args.turnId,
      mode:                args.mode,
      messages:            args.messages,
      modelContextWindow:  args.modelContextWindow,
      providerId:          args.providerId,
      model:               args.compactionModel,
      recentFiles:         args.recentFiles,
      signal:              args.signal,
      emit:                args.emit,
    });
    let working = compactRes.messages;

    // 2. Recall
    const bundle = await this.plan({
      sessionId: args.sessionId,
      turnId:    args.turnId,
      mode:      args.mode,
      userInput: args.userInput,
      signal:    args.signal,
      emit:      args.emit,
    });

    // 3. Inject context message right BEFORE the trailing user message.
    // The engine always appends the current user turn last; we slot the
    // recall context between history-tail and the user turn so the model
    // sees: history → context → current user.
    const ctxMsg = buildContextMessage(bundle);
    let tokenEstimate = 0;
    if (ctxMsg) {
      tokenEstimate = typeof ctxMsg.content === 'string'
        ? estimateTextTokens(ctxMsg.content)
        : 0;
      const lastIdx = working.length - 1;
      const lastIsUser =
        lastIdx >= 0 && working[lastIdx]?.role === 'user';
      if (lastIsUser) {
        working = [...working.slice(0, lastIdx), ctxMsg, working[lastIdx]!];
      } else {
        working = [...working, ctxMsg];
      }
    }

    return {
      messages:      working,
      compactionRan: compactRes.macroRan,
      microCleared:  compactRes.microCleared,
      tokenEstimate,
      recallSummary: {
        layer0:    bundle.layer0?.nodes.length ?? 0,
        layer1:    bundle.layer1 !== null,
        layer2:    (bundle.layer2?.currentMode.length ?? 0)
                 + (bundle.layer2?.otherModes.length ?? 0),
      },
    };
  }

  // ── Index mutation hooks (used by Round 3 extraction pipeline) ──────────────

  /**
   * Add or update a node's vector in the index after a successful write to
   * memory_nodes. Caller is responsible for keeping DB + index in sync — this
   * method is the index half.
   */
  indexUpsertNode(id: string, vec: Float32Array): void {
    this.nodesIndex?.update(id, vec);
  }

  indexRemoveNode(id: string): void {
    this.nodesIndex?.remove(id);
  }

  indexUpsertItem(id: string, vec: Float32Array): void {
    this.itemsIndex?.update(id, vec);
  }

  indexRemoveItem(id: string): void {
    this.itemsIndex?.remove(id);
  }

  /** Inspection helper — useful for diagnostics and tests. */
  indexStats(): {
    nodes: { size: number; backend: string } | null;
    items: { size: number; backend: string } | null;
  } {
    return {
      nodes: this.nodesIndex
        ? { size: this.nodesIndex.size(), backend: this.nodesIndex.backend }
        : null,
      items: this.itemsIndex
        ? { size: this.itemsIndex.size(), backend: this.itemsIndex.backend }
        : null,
    };
  }

  // ── Per-session overrides ───────────────────────────────────────────────────

  /**
   * Read the active overrides for a session. Always returns a fully-resolved
   * object — defaults to all-on when no override has been persisted.
   * Used by the UI memory panel to populate its toggle state.
   */
  getSessionOverrides(sessionId: SessionId): ResolvedSessionOverrides {
    return readOverrides(this.deps.memorySessionState, sessionId);
  }

  /**
   * Persist per-session overrides. Partial input — only the keys you set are
   * stored; remaining keys keep their default behaviour. Called by the UI
   * when a user toggles a memory layer for one specific conversation.
   */
  setSessionOverrides(sessionId: SessionId, overrides: MemorySessionOverrides): void {
    writeOverrides(this.deps.memorySessionState, sessionId, overrides);
  }

  // ── Stats / Inspection (UI memory panel) ────────────────────────────────────

  /** Aggregate counts + sizes for the memory dashboard. */
  getStats(): MemoryStats {
    return collectStats(
      this.deps,
      { nodesIndex: this.nodesIndex, itemsIndex: this.itemsIndex },
      this.embed.currentProviderId() ?? null,
    );
  }

  listNodes(opts?: BrowseNodesOptions) {
    return browseNodes(this.deps, opts);
  }

  listItems(opts?: BrowseItemsOptions) {
    return browseItems(this.deps, opts);
  }

  listEdgesForNodes(nodeIds: string[]) {
    return browseEdgesForNodes(this.deps, nodeIds);
  }

  // ── Maintenance (decay + user-initiated delete) ─────────────────────────────

  /**
   * Run an importance-decay pass over un-referenced rows. UI calls this first
   * with `dryRun: true` to show a preview, then again with `dryRun: false`
   * after the user confirms. Protected node types are never decayed.
   */
  runMaintenance(opts: Partial<MaintenanceOptions> = {}): MaintenanceReport {
    return runMaintenance(this.deps, {
      decayAfterDays: opts.decayAfterDays ?? this.settings.maintenance.decayAfterDays,
      decayAmount:    opts.decayAmount    ?? this.settings.maintenance.decayAmount,
      decayItems:     opts.decayItems     ?? true,
      dryRun:         opts.dryRun         ?? true,
      nowMs:          opts.nowMs          ?? Date.now(),
    });
  }

  /** Hard-delete one node (and cascading edges + lazy_updates). */
  deleteNode(nodeId: string): void {
    deleteNode(this.deps, nodeId);
    this.indexRemoveNode(nodeId);
  }

  /** Hard-delete one memory item. */
  deleteItem(itemId: string): void {
    deleteItem(this.deps, itemId);
    this.indexRemoveItem(itemId);
  }

  /** Cleanup: hard-delete every zero-importance row older than N days. */
  hardDeleteZeroImportance(thresholdDays: number) {
    return hardDeleteZeroImportance(this.deps, thresholdDays);
  }

  // ── afterTurn: append fragments + maybe enqueue extraction ──────────────────

  /**
   * Called by the engine (via hook) after a turn completes successfully.
   * Appends raw user/assistant text to the pending buffer and enqueues an
   * extraction task if either threshold is met.
   *
   * No-op when memory is disabled or essential clients missing. Fully
   * best-effort; failures never propagate.
   */
  async afterTurn(ctx: {
    sessionId:     SessionId;
    turnId:        string;
    mode:          TurnMode;
    userText:      string;
    assistantText: string;
  }): Promise<void> {
    if (!this.settings.enabled) return;

    // Per-session override: extraction off → don't even buffer this turn.
    // The user is explicitly saying "this conversation should not feed memory".
    const overrides = this.getSessionOverrides(ctx.sessionId);
    if (!overrides.extraction) return;

    const fragments = buildFragmentsFromTurn({
      turnId:        ctx.turnId as never,
      userText:      ctx.userText,
      assistantText: ctx.assistantText,
      at:            Date.now(),
    });

    bestEffort('appendPending', () => {
      for (const f of fragments) {
        appendPending(this.deps.pendingFragments, ctx.sessionId, f, Date.now());
      }
    }, undefined);

    // Trigger evaluation
    const pending = bestEffort('readPending',
      () => readPending(this.deps.pendingFragments, ctx.sessionId), null);
    if (pending === null) return;
    if (!shouldExtract(pending, {
      tokenThreshold: this.settings.triggers.pendingTokenThreshold,
      turnThreshold:  this.settings.triggers.pendingTurnThreshold,
    })) {
      return;
    }

    // Enqueue extraction task (durable, survives crash)
    bestEffort('enqueue extraction', () => {
      this.runner.enqueue('extraction', ctx.sessionId, {
        sessionId: ctx.sessionId,
        mode:      ctx.mode,
      });
    }, undefined);
  }

  /** Force-enqueue an extraction task regardless of thresholds (e.g. session close). */
  async forceExtract(sessionId: SessionId, mode: TurnMode): Promise<void> {
    bestEffort('forceExtract enqueue', () => {
      this.runner.enqueue('extraction', sessionId, { sessionId, mode });
    }, undefined);
  }

  /** Allow the orchestrator to drive periodic ticks (e.g. on a 5s interval). */
  async tick(): Promise<void> {
    await this.runner.tick();
  }

  /** Drain all in-flight session work — called at graceful shutdown. */
  async drain(): Promise<void> {
    await this.queue.drainAll();
  }

  /**
   * Run all post-crash hygiene checks: reset stuck tasks, clean orphan
   * lazy_updates, count stale embeddings, list sessions with pending
   * fragments. Sync — safe to call from sidecar bootstrap before tick starts.
   * Returns a small report the caller can log or surface to the UI.
   */
  runStartupRecovery(): RecoveryReport {
    return doStartupRecovery(this.deps, this.embed);
  }

  // ── Compaction ──────────────────────────────────────────────────────────────

  /**
   * Run the two-stage compaction pipeline against an in-flight messages array.
   *
   *   Stage A — Microcompaction (free, fast)
   *     Replaces stale tool_result content with a cleared placeholder.
   *     Only meaningfully reduces tokens in agent mode with many tool calls.
   *
   *   Stage B — Macrocompaction (LLM-driven)
   *     Triggered only when post-micro token estimate is still over the
   *     model's context window minus `bufferTokens`. Calls the memory LLM
   *     binding with a mode-specific summary template, persists a single
   *     `kind: 'summary'` message (doubles as boundary), and rebuilds the
   *     messages array as [summary, ...tail, ...post-compact restore].
   *
   * Returns the (possibly-new) message array and a flag indicating whether
   * macrocompaction ran. The hook caller uses this to update payload.messages.
   *
   * Failure-safe: any failure inside macro returns the post-micro messages
   * unchanged and `succeeded: false`. Memory must never block a turn.
   */
  async compact(args: {
    sessionId:           SessionId;
    turnId:              TurnId;
    mode:                TurnMode;
    messages:            LlmMessage[];
    modelContextWindow:  number;
    /** Current turn's provider (from frontend picker). Used for the compaction LLM call. */
    providerId?:         string;
    /** Current turn's model. */
    model?:              string;
    recentFiles?:        ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
    signal?:             AbortSignal;
    emit?:               (event: EmaStreamEvent) => void;
  }): Promise<CompactResult> {
    const now = Date.now();
    const beforeTokens = estimateMessagesTokens(args.messages);

    if (!this.settings.enabled) {
      return { messages: args.messages, macroRan: false, microCleared: 0, succeeded: true, beforeTokens, afterTokens: beforeTokens, savedTokens: 0 };
    }

    // Per-session override: compaction off → caller takes responsibility for
    // staying under the context window. We still pass-through the messages.
    const overrides = this.getSessionOverrides(args.sessionId);
    if (!overrides.compaction) {
      return { messages: args.messages, macroRan: false, microCleared: 0, succeeded: true, beforeTokens, afterTokens: beforeTokens, savedTokens: 0 };
    }

    const buffer = this.settings.compaction.bufferTokens;
    const threshold = args.modelContextWindow - buffer;

    // Stage A: micro
    const micro = microCompact(args.messages, { keepRecent: 6 });
    let working = micro.messages;
    let estimated = estimateMessagesTokens(working);

    if (estimated <= threshold) {
      return {
        messages:     working,
        macroRan:     false,
        microCleared: micro.cleared,
        succeeded:    true,
        beforeTokens,
        afterTokens: estimated,
        savedTokens: beforeTokens - estimated,
      };
    }

    // Stage B: macro. Decide the split: preserve the LAST `tailSize` messages,
    // compact everything before.
    const tailSize = Math.max(8, Math.ceil(working.length * 0.25));
    if (working.length <= tailSize) {
      // Not enough older messages to compact — accept the micro result and proceed
      return {
        messages:     working,
        macroRan:     false,
        microCleared: micro.cleared,
        succeeded:    true,
        beforeTokens,
        afterTokens: estimated,
        savedTokens: beforeTokens - estimated,
      };
    }
    const safeCut = findSafeCutPoint(working, working.length - tailSize);
    const head = working.slice(0, safeCut);
    const tail = working.slice(safeCut);

    args.emit?.({
      type:       'memory_compaction_started',
      sessionId:  args.sessionId,
      turnId:     args.turnId,
      mode:       args.mode,
      beforeTokens,
    })

    const result = await runMacroCompaction({
      llm:                this.deps.llm,
      providerId:         args.providerId ?? this.deps.llm.firstProviderId() ?? '',
      model:              args.model      ?? this.deps.llm.defaultModelFor(args.providerId ?? this.deps.llm.firstProviderId() ?? '') ?? '',
      session:            this.deps.session,
      sessionId:          args.sessionId,
      turnId:             args.turnId,
      mode:               args.mode,
      toCompact:          head,
      modelContextWindow: args.modelContextWindow,
      signal:             args.signal,
    });

    if (!result.succeeded || !result.summary) {

      args.emit?.({
        type:       'memory_compaction_failed',
        sessionId:  args.sessionId,
        turnId:     args.turnId,
        mode:       args.mode,
        beforeTokens,
        afterTokens: estimated,
        error:      macroFailureReason(result.attempts),
        durationMs: Date.now() - now,
      })
      // Macro failed — fall through with what we have. Caller still proceeds.
      return {
        messages:     working,
        macroRan:     false,
        microCleared: micro.cleared,
        succeeded:    false,
        beforeTokens,
        afterTokens: estimated,
        savedTokens: beforeTokens - estimated,
      };
    }

    // Build the rebuilt message array: summary + restore + tail
    const summaryMsg: LlmMessage = {
      role: 'user',
      content: `<context-summary mode="${args.mode}">
${result.summary}
</context-summary>`,
    };
    const restore = buildPostCompactRestore(this.deps, {
      sessionId:    args.sessionId,
      mode:         args.mode,
      recentFiles:  args.recentFiles,
    });

    working = [summaryMsg, ...restore, ...tail];

    const afterTokens = estimateMessagesTokens(working);

    args.emit?.({
      type:       'memory_compaction_completed',
      sessionId:  args.sessionId,
      turnId:     args.turnId,
      mode:       args.mode,
      beforeTokens,
      afterTokens: afterTokens,
      savedTokens: Math.max(0, beforeTokens - afterTokens),
      durationMs: Date.now() - now,
    })

    return {
      messages:     working,
      macroRan:     true,
      microCleared: micro.cleared,
      succeeded:    true,
      beforeTokens,
      afterTokens: afterTokens,
      savedTokens: Math.max(0, beforeTokens - afterTokens),
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async rerankLayer0(
    query:  string,
    result: GraphRecallResult,
    signal?: AbortSignal,
  ): Promise<GraphRecallResult> {
    const providerId = this.deps.ebd.firstRerankId();
    const model      = providerId ? this.deps.ebd.defaultRerankModelFor(providerId) : undefined;
    if (!providerId || !model) return result;

    try {
      const documents = result.nodes.map(n => `${n.label}: ${n.description}`);
      const resp = await this.deps.ebd.rerank({
        providerId, model, query,
        documents,
        topK: documents.length,
        signal,
      });
      // Build score map by original index — handle providers that return partial results
      const scores = new Map(resp.results.map(r => [r.index, r.score]));
      const reranked = [...result.nodes]
        .map((node, i) => ({ node, score: scores.get(i) ?? -Infinity }))
        .sort((a, b) => b.score - a.score)
        .map(x => x.node);
      return { nodes: reranked, edges: result.edges };
    } catch {
      return result;
    }
  }

  private async rerankEpisodic(
    query:  string,
    result: EpisodicRecallResult,
    signal?: AbortSignal,
  ): Promise<EpisodicRecallResult> {
    const providerId = this.deps.ebd.firstRerankId();
    const model      = providerId ? this.deps.ebd.defaultRerankModelFor(providerId) : undefined;
    if (!providerId || !model) return result;

    try {
      // Concatenate both lists so we do one rerank call; remember the split point
      const allItems  = [...result.currentMode, ...result.otherModes];
      const documents = allItems.map(i => `${i.title}: ${i.body}`);
      const resp = await this.deps.ebd.rerank({
        providerId, model, query,
        documents,
        topK: documents.length,
        signal,
      });
      const scores = new Map(resp.results.map(r => [r.index, r.score]));

      const rerank = <T>(items: T[], offset: number): T[] =>
        [...items]
          .map((item, i) => ({ item, score: scores.get(offset + i) ?? -Infinity }))
          .sort((a, b) => b.score - a.score)
          .map(x => x.item);

      return {
        currentMode: rerank(result.currentMode, 0),
        otherModes:  rerank(result.otherModes,  result.currentMode.length),
      };
    } catch {
      return result;
    }
  }

  private async safeEmbedQuery(text: string) {
    return bestEffortAsync('embedQuery', () => this.embed.embedQuery(text), null);
  }

  private loadAlreadySurfaced(sessionId: SessionId): AlreadySurfaced {
    return loadSurfaced(this.deps.memorySessionState.getSurfaced(sessionId));
  }

  private recordSurfaced(
    sessionId: SessionId,
    prior:     AlreadySurfaced,
    bundle:    { layer0: ReturnType<typeof recallGraph> | null | undefined;
                 layer2: Awaited<ReturnType<typeof recallEpisodic>> | null | undefined; },
  ): void {
    const nowMs = Date.now();
    const newNodes: string[] = [];
    const newItems: string[] = [];

    if (bundle.layer0) {
      for (const n of bundle.layer0.nodes) newNodes.push(n.id);
    }
    if (bundle.layer2) {
      for (const i of bundle.layer2.currentMode) newItems.push(i.id);
      for (const i of bundle.layer2.otherModes)  newItems.push(i.id);
    }

    const boost = {
      maxBoost: this.settings.maintenance.reReferenceBoostMax,
      halfLifeDays: this.settings.maintenance.reReferenceHalfLifeDays,
      saturationStart: this.settings.maintenance.boostSaturationStart,
      saturationSlope: this.settings.maintenance.boostSaturationSlope,
    };

    bestEffort('touchReferenced nodes', () => this.deps.nodes.touchReferenced(newNodes, nowMs, boost), undefined);
    bestEffort('touchReferenced items', () => this.deps.items.touchReferenced(newItems, nowMs, boost), undefined);

    const merged: AlreadySurfaced = {
      nodes:     dedupTail([...prior.nodes, ...newNodes], 200),
      items:     dedupTail([...prior.items, ...newItems], 200),
      updatedAt: nowMs,
    };
    bestEffort('persistSurfaced', () =>
      this.deps.memorySessionState.setSurfaced(sessionId, merged as unknown as Record<string, unknown>),
    undefined);
  }
}

// ── Context message builder ──────────────────────────────────────────────────

function buildContextMessage(bundle: RecallBundle): LlmMessage | null {
  const parts: string[] = [];

  const fmtDate = (ms: number) =>
    new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

  if (bundle.layer0 && bundle.layer0.nodes.length > 0) {
    const nodes = bundle.layer0.nodes
      .map(n => `- (${n.nodeType}) ${n.label}: ${n.description}`)
      .join('\n');
    const edges = bundle.layer0.edges.length === 0 ? '' :
      '\n\n关系:\n' + bundle.layer0.edges
        .map(e => `- ${e.from} —${e.relation}→ ${e.to}`)
        .join('\n');
    parts.push(`## 我对你的了解\n${nodes}${edges}`);
  }

  if (bundle.layer1) {
    parts.push(`## 当前会话摘要\n${bundle.layer1}`);
  }

  if (bundle.layer2) {
    const blob: string[] = [];
    if (bundle.layer2.currentMode.length > 0) {
      blob.push('当前模式相关:');
      for (const i of bundle.layer2.currentMode) {
        const ts = i.updatedAt ? ` (${fmtDate(i.updatedAt)})` : '';
        blob.push(`- [${i.kind}]${ts} ${i.title}: ${i.body}`);
      }
    }
    if (bundle.layer2.otherModes.length > 0) {
      blob.push('\n其他模式相关:');
      for (const i of bundle.layer2.otherModes) {
        const ts = i.updatedAt ? ` (${fmtDate(i.updatedAt)})` : '';
        blob.push(`- [${i.kind}]${ts} ${i.title}: ${i.body}`);
      }
    }
    if (blob.length > 0) parts.push(`## 相关的过往\n${blob.join('\n')}`);
  }

  if (parts.length === 0) return null;

  return {
    role:    'user',
    content: `<memory>\n${parts.join('\n\n')}\n</memory>`,
  };
}

// ── Tiny helpers ─────────────────────────────────────────────────────────────

function dedupTail<T>(arr: T[], maxLen: number): T[] {
  const seen = new Set<T>();
  const out:  T[] = [];
  for (let i = arr.length - 1; i >= 0 && out.length < maxLen; i--) {
    const v = arr[i]!;
    if (seen.has(v)) continue;
    seen.add(v);
    out.unshift(v);
  }
  return out;
}

// ── Compaction safe-cut helpers ───────────────────────────────────────────────
//
// The Anthropic / OpenAI APIs require tool_use blocks in an assistant message
// to be immediately followed by a user message containing the matching
// tool_result blocks. A naive slice can land between that pair, producing an
// orphaned tool_result at the start of `tail` — which the API rejects.
//
// findSafeCutPoint walks backward from the desired cut index until it reaches
// a boundary that does not split a tool_use/tool_result pair:
//   - Skip user messages whose content is entirely tool_result blocks.
//   - Skip the assistant message preceding them (which contains tool_use).
// The returned index is the first message that belongs in `tail`.

function findSafeCutPoint(messages: LlmMessage[], desiredCut: number): number {
  for (let i = desiredCut; i > 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'user' && Array.isArray(msg.content) && isAllToolResults(msg.content)) {
      continue; // tool_result msg — can't start a tail here, skip
    }
    if (msg.role === 'assistant' && Array.isArray(msg.content) && hasAnyToolUse(msg.content)) {
      continue; // tool_use msg whose results are at i+1 — keep both in tail
    }
    return i;
  }
  return 0;
}

function isAllToolResults(blocks: unknown[]): boolean {
  return blocks.length > 0 &&
    blocks.every((b) => (b as { type?: string }).type === 'tool_result');
}

function hasAnyToolUse(blocks: unknown[]): boolean {
  return blocks.some((b) => (b as { type?: string }).type === 'tool_use');
}

function emitRecallLayer(
  ctx: PlanContext,
  layer: 'layer0' | 'layer1' | 'layer2',
  report: {
    status: 'succeeded' | 'skipped' | 'failed';
    itemCount: number;
    tokenEstimate: number;
    durationMs: number;
    error?: string;
    skippedReason?: string;
  },
): void {
  ctx.emit?.({
    type: 'memory_recall_evidence',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    mode: ctx.mode,
    layer,
    report,
  });
}

function estimateGraphRecallTokens(result: NonNullable<RecallBundle['layer0']>): number {
  const nodes = result.nodes
    .map((n) => `${n.nodeType} ${n.label}: ${n.description}`)
    .join('\n');
  const edges = result.edges
    .map((e) => `${e.from} ${e.relation} ${e.to}`)
    .join('\n');
  return estimateTextTokens([nodes, edges].filter(Boolean).join('\n'));
}

function countEpisodicItems(result: NonNullable<RecallBundle['layer2']>): number {
  return result.currentMode.length + result.otherModes.length;
}

function estimateEpisodicRecallTokens(result: NonNullable<RecallBundle['layer2']>): number {
  const items = [...result.currentMode, ...result.otherModes]
    .map((i) => `${i.kind} ${i.title}: ${i.body}`)
    .join('\n');
  return estimateTextTokens(items);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function macroFailureReason(attempts: number): string {
  if (attempts <= 0) return 'Macro compaction did not run: no compaction binding or empty compaction slice';
  return `Macro compaction failed after ${attempts} attempt(s)`;
}
