import type { SessionId, TurnId, TurnMode } from '@ema-agent/contracts';
import type { LlmMessage } from '@ema-agent/llm';
import type { MemoryDeps } from './deps.js';
import type {
  PlanContext, RecallBundle, MemorySettings, AlreadySurfaced,
} from './types.js';
import { DEFAULT_MEMORY_SETTINGS } from './types.js';
import { EmbedService }     from './embed/service.js';
import { recallGraph }      from './recall/layer0-graph.js';
import { recallSessionNote } from './recall/layer1-notes.js';
import { recallEpisodic }   from './recall/layer2-episodic.js';
import { recallNarrative }  from './recall/narrative.js';
import { createVectorIndex } from './index/factory.js';
import { rebuildNodesIndex, rebuildItemsIndex } from './index/builder.js';
import type { VectorIndex } from './index/vector-index.js';
import {
  appendPending, readPending, shouldExtract, buildFragmentsFromTurn,
} from './extract/pending.js';
import { SessionTaskQueue } from './tasks/session-queue.js';
import { BackgroundTaskRunner } from './tasks/runner.js';
import { microCompact } from './compact/micro.js';
import { runMacroCompaction } from './compact/macro.js';
import { buildPostCompactRestore } from './compact/restore.js';
import { estimateMessagesTokens } from './tokens/estimate.js';
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

const SURFACED_META_KEY = 'memory.alreadySurfaced';
const SURFACED_TTL_MS   = 1000 * 60 * 60 * 6;   // 6 hours

function loadSurfaced(meta: Record<string, unknown>): AlreadySurfaced {
  const raw = meta[SURFACED_META_KEY];
  if (!raw || typeof raw !== 'object') {
    return { nodes: [], items: [], updatedAt: Date.now() };
  }
  const entry = raw as Partial<AlreadySurfaced>;
  if (Date.now() - (entry.updatedAt ?? 0) > SURFACED_TTL_MS) {
    return { nodes: [], items: [], updatedAt: Date.now() };
  }
  return {
    nodes:     Array.isArray(entry.nodes) ? entry.nodes.slice(-200) : [],
    items:     Array.isArray(entry.items) ? entry.items.slice(-200) : [],
    updatedAt: entry.updatedAt ?? Date.now(),
  };
}

// ── MemoryPlanner Façade ─────────────────────────────────────────────────────

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
  private readonly runner: BackgroundTaskRunner;

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
    };

    this.queue  = new SessionTaskQueue();
    this.runner = new BackgroundTaskRunner({
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

    const dim   = this.deps.ebd.embedDimFor(providerId);
    if (!dim) return { nodes: 0, items: 0, backend: null };

    const model = this.deps.ebd.defaultEmbedModelFor(providerId);
    if (!model) return { nodes: 0, items: 0, backend: null };

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
      return { layer0: null, layer1: null, layer2: null, narrative: null };
    }

    const overrides = this.getSessionOverrides(ctx.sessionId);
    const surfaced  = this.loadAlreadySurfaced(ctx.sessionId);

    // Embed the user message once and pass both representations downstream
    const embedded = this.embed.isAvailable()
      ? await this.safeEmbedQuery(ctx.userInput)
      : null;
    const queryVec   = embedded?.queryVec ?? null;
    const queryEmbed = embedded?.embedded ?? null;

    // ── Layer 0 ─ subject to override ─────────────────────────────────────────
    const layer0 = overrides.layer0
      ? safeCall(() => recallGraph(this.deps, {
          queryVec,
          queryEmbed,
          index:           this.nodesIndex,
          alreadySurfaced: new Set(surfaced.nodes),
          settings:        this.settings,
        }))
      : null;

    // ── Layer 1 ─ subject to override ─────────────────────────────────────────
    const layer1 = overrides.layer1
      ? safeCall(() => recallSessionNote(this.deps, ctx.sessionId))
      : null;

    // ── Layer 2 / narrative ─ subject to override ─────────────────────────────
    let layer2: RecallBundle['layer2']    = null;
    let narrative: RecallBundle['narrative'] = null;

    if (ctx.mode === 'narrative') {
      if (overrides.narrative) {
        narrative = await safeAsync(() =>
          recallNarrative(this.deps, ctx.userInput, ctx.signal),
        );
      }
    } else if (overrides.layer2) {
      const layer2Mode: 'chat' | 'agent' = ctx.mode;
      layer2 = await safeAsync(() => recallEpisodic(this.deps, {
        query:           ctx.userInput,
        queryVec,
        queryEmbed,
        index:           this.itemsIndex,
        mode:            layer2Mode,
        alreadySurfaced: new Set(surfaced.items),
        settings:        this.settings,
      }));
    }

    this.recordSurfaced(ctx.sessionId, surfaced, { layer0, layer2 });

    return {
      layer0:    layer0    ?? null,
      layer1:    layer1    ?? null,
      layer2:    layer2    ?? null,
      narrative: narrative ?? null,
    };
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
    recentFiles?:       ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
    signal?:            AbortSignal;
  }): Promise<{
    messages:        LlmMessage[];
    compactionRan:   boolean;
    microCleared:    number;
    recallSummary:   { layer0: number; layer1: boolean; layer2: number; narrative: boolean };
  }> {
    if (!this.settings.enabled) {
      return {
        messages:      args.messages,
        compactionRan: false,
        microCleared:  0,
        recallSummary: { layer0: 0, layer1: false, layer2: 0, narrative: false },
      };
    }

    // 1. Compact
    const compactRes = await this.compact({
      sessionId:           args.sessionId,
      turnId:              args.turnId,
      mode:                args.mode,
      messages:            args.messages,
      modelContextWindow:  args.modelContextWindow,
      recentFiles:         args.recentFiles,
      signal:              args.signal,
    });
    let working = compactRes.messages;

    // 2. Recall
    const bundle = await this.plan({
      sessionId: args.sessionId,
      turnId:    args.turnId,
      mode:      args.mode,
      userInput: args.userInput,
      signal:    args.signal,
    });

    // 3. Inject context message right BEFORE the trailing user message.
    // The engine always appends the current user turn last; we slot the
    // recall context between history-tail and the user turn so the model
    // sees: history → context → current user.
    const ctxMsg = buildContextMessage(bundle);
    if (ctxMsg) {
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
      recallSummary: {
        layer0:    bundle.layer0?.nodes.length ?? 0,
        layer1:    bundle.layer1 !== null,
        layer2:    (bundle.layer2?.currentMode.length ?? 0)
                 + (bundle.layer2?.otherModes.length ?? 0),
        narrative: bundle.narrative !== null,
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
    return readOverrides(this.deps.sessions, sessionId);
  }

  /**
   * Persist per-session overrides. Partial input — only the keys you set are
   * stored; remaining keys keep their default behaviour. Called by the UI
   * when a user toggles a memory layer for one specific conversation.
   */
  setSessionOverrides(sessionId: SessionId, overrides: MemorySessionOverrides): void {
    writeOverrides(this.deps.sessions, sessionId, overrides, this.deps.db.sqlite);
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
    return runMaintenance(this.deps, opts);
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

    try {
      for (const f of fragments) {
        appendPending(this.deps.sessions, ctx.sessionId, f, Date.now());
      }
    } catch { /* ignore — extraction will retry next time */ }

    // Trigger evaluation
    let pending;
    try {
      pending = readPending(this.deps.sessions, ctx.sessionId);
    } catch {
      return;
    }
    if (!shouldExtract(pending, {
      tokenThreshold: this.settings.triggers.pendingTokenThreshold,
      turnThreshold:  this.settings.triggers.pendingTurnThreshold,
    })) {
      return;
    }

    // Enqueue extraction task (durable, survives crash)
    try {
      this.runner.enqueue('extraction', ctx.sessionId, {
        sessionId: ctx.sessionId,
        mode:      ctx.mode,
      });
    } catch { /* ignore */ }
  }

  /** Force-enqueue an extraction task regardless of thresholds (e.g. session close). */
  async forceExtract(sessionId: SessionId, mode: TurnMode): Promise<void> {
    try {
      this.runner.enqueue('extraction', sessionId, { sessionId, mode });
    } catch { /* ignore */ }
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
    recentFiles?:        ReadonlyArray<{ path: string; content: string; mtimeMs: number }>;
    signal?:             AbortSignal;
  }): Promise<{
    messages: LlmMessage[];
    macroRan: boolean;
    microCleared: number;
    succeeded: boolean;
  }> {
    if (!this.settings.enabled) {
      return { messages: args.messages, macroRan: false, microCleared: 0, succeeded: true };
    }

    // Per-session override: compaction off → caller takes responsibility for
    // staying under the context window. We still pass-through the messages.
    const overrides = this.getSessionOverrides(args.sessionId);
    if (!overrides.compaction) {
      return { messages: args.messages, macroRan: false, microCleared: 0, succeeded: true };
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
      };
    }
    const head = working.slice(0, working.length - tailSize);
    const tail = working.slice(working.length - tailSize);

    const result = await runMacroCompaction({
      llm:                this.deps.llm,
      modelBindings:      this.deps.modelBindings,
      session:            this.deps.session,
      sessionId:          args.sessionId,
      turnId:             args.turnId,
      mode:               args.mode,
      toCompact:          head,
      modelContextWindow: args.modelContextWindow,
      signal:             args.signal,
    });

    if (!result.succeeded || !result.summary) {
      // Macro failed — fall through with what we have. Caller still proceeds.
      return {
        messages:     working,
        macroRan:     false,
        microCleared: micro.cleared,
        succeeded:    false,
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

    return {
      messages:     working,
      macroRan:     true,
      microCleared: micro.cleared,
      succeeded:    true,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async safeEmbedQuery(text: string) {
    try { return await this.embed.embedQuery(text); }
    catch { return null; }
  }

  private loadAlreadySurfaced(sessionId: SessionId): AlreadySurfaced {
    const session = this.deps.session.getSession(sessionId);
    return loadSurfaced(session.meta);
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

    try { this.deps.nodes.touchReferenced(newNodes, nowMs); } catch { /* ignore */ }
    try { this.deps.items.touchReferenced(newItems, nowMs); } catch { /* ignore */ }

    const merged: AlreadySurfaced = {
      nodes:     dedupTail([...prior.nodes, ...newNodes], 200),
      items:     dedupTail([...prior.items, ...newItems], 200),
      updatedAt: nowMs,
    };
    try {
      this.persistSurfaced(sessionId, merged);
    } catch { /* ignore */ }
  }

  private persistSurfaced(sessionId: SessionId, surfaced: AlreadySurfaced): void {
    const row = this.deps.sessions.findById(sessionId);
    if (!row) return;
    const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
    meta[SURFACED_META_KEY] = surfaced;
    this.deps.db.sqlite
      .prepare('UPDATE sessions SET meta_json = ? WHERE id = ?')
      .run(JSON.stringify(meta), sessionId);
  }
}

// ── Context message builder ──────────────────────────────────────────────────

function buildContextMessage(bundle: RecallBundle): LlmMessage | null {
  const parts: string[] = [];

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
        blob.push(`- [${i.kind}] ${i.title}: ${i.body}`);
      }
    }
    if (bundle.layer2.otherModes.length > 0) {
      blob.push('\n其他模式相关:');
      for (const i of bundle.layer2.otherModes) {
        blob.push(`- [${i.kind}] ${i.title}: ${i.body}`);
      }
    }
    if (blob.length > 0) parts.push(`## 相关的过往\n${blob.join('\n')}`);
  }

  if (bundle.narrative) {
    const sections = Object.entries(bundle.narrative.sections)
      .map(([t, body]) => `### ${t}\n${body}`)
      .join('\n\n');
    parts.push(`## 故事召回\n${sections}`);
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

function safeCall<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

async function safeAsync<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}
