import type { SessionId, TurnMode } from '@ema-agent/contracts';
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
      memory:        deps,
      embed:         this.embed,
      settings:      this.settings,
      queue:         this.queue,
      getNodesIndex: () => this.nodesIndex,
      getItemsIndex: () => this.itemsIndex,
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

    const dim = this.deps.ebd.embedDimFor(providerId);
    if (!dim) return { nodes: 0, items: 0, backend: null };

    this.indexProviderId = providerId;
    this.indexDim        = dim;
    this.nodesIndex      = await createVectorIndex(dim);
    this.itemsIndex      = await createVectorIndex(dim);

    const nodes = rebuildNodesIndex(this.nodesIndex, this.deps.nodes, providerId);
    const items = rebuildItemsIndex(this.itemsIndex, this.deps.items, providerId);

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

    const surfaced = this.loadAlreadySurfaced(ctx.sessionId);

    // Embed the user message once and pass both representations downstream
    const embedded = this.embed.isAvailable()
      ? await this.safeEmbedQuery(ctx.userInput)
      : null;
    const queryVec   = embedded?.queryVec ?? null;
    const queryEmbed = embedded?.embedded ?? null;

    // ── Layer 0: always run ───────────────────────────────────────────────────
    const layer0 = safeCall(() => recallGraph(this.deps, {
      queryVec,
      queryEmbed,
      index:           this.nodesIndex,
      alreadySurfaced: new Set(surfaced.nodes),
      settings:        this.settings,
    }));

    // ── Layer 1: always run ───────────────────────────────────────────────────
    const layer1 = safeCall(() => recallSessionNote(this.deps, ctx.sessionId));

    // ── Layer 2: chat / agent only; narrative mode replaces with LightRAG ─────
    let layer2: RecallBundle['layer2']    = null;
    let narrative: RecallBundle['narrative'] = null;

    if (ctx.mode === 'narrative') {
      narrative = await safeAsync(() =>
        recallNarrative(this.deps, ctx.userInput, ctx.signal),
      );
    } else {
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

  /** Round 4: micro + macro compaction with mode-specific prompts. */
  async compact(_ctx: { sessionId: SessionId }): Promise<{ compacted: boolean }> {
    return { compacted: false };
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
