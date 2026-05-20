import type { SessionId } from '@ema-agent/contracts';
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
 *   plan(ctx)        — beforeLlm: assemble the 3-layer RecallBundle.
 *   afterTurn(ctx)   — onTurnEnd: append turn to pending_fragments (Round 3 wires extraction).
 *   compact(ctx)     — beforeLlm pre-send: macro/micro compaction (Round 4).
 *
 * MemoryPlanner is the only thing the orchestrator wires for memory; the hook
 * registrations live in `registerMemoryHooks()` (separate file, Round 4).
 */
export class MemoryPlanner {
  private readonly embed: EmbedService;
  private readonly settings: MemorySettings;

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
  }

  // ── Read settings (orchestrator may surface them to UI) ─────────────────────
  getSettings(): MemorySettings { return this.settings; }

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
    const queryEmbed = this.embed.isAvailable()
      ? await this.safeEmbed(ctx.userInput)
      : null;

    // ── Layer 0: always run ───────────────────────────────────────────────────
    const layer0 = safeCall(() => recallGraph(this.deps, {
      queryEmbed,
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
      // ctx.mode is 'chat' | 'agent' here — narrative branch returned above
      const layer2Mode: 'chat' | 'agent' = ctx.mode;
      layer2 = await safeAsync(() => recallEpisodic(this.deps, {
        query:           ctx.userInput,
        queryEmbed,
        mode:            layer2Mode,
        alreadySurfaced: new Set(surfaced.items),
        settings:        this.settings,
      }));
    }

    // Update `last_referenced_at` + alreadySurfaced ledger (best-effort)
    this.recordSurfaced(ctx.sessionId, surfaced, { layer0, layer2 });

    return {
      layer0:    layer0    ?? null,
      layer1:    layer1    ?? null,
      layer2:    layer2    ?? null,
      narrative: narrative ?? null,
    };
  }

  // ── Stubs for upcoming rounds ───────────────────────────────────────────────

  /** Round 3: append pending fragments + maybe enqueue extraction task. */
  async afterTurn(_ctx: { sessionId: SessionId; turnId: string }): Promise<void> {
    /* implemented in Round 3 */
  }

  /** Round 4: micro + macro compaction with mode-specific prompts. */
  async compact(_ctx: { sessionId: SessionId }): Promise<{ compacted: boolean }> {
    return { compacted: false };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async safeEmbed(text: string) {
    try { return await this.embed.embedOne(text); }
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

    // Touch last_referenced_at on the DB rows (best-effort, swallow errors)
    try { this.deps.nodes.touchReferenced(newNodes, nowMs); } catch { /* ignore */ }
    try { this.deps.items.touchReferenced(newItems, nowMs); } catch { /* ignore */ }

    // Update session.meta_json bucket so next turn knows not to re-surface
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
    // session_store currently has no generic meta updater; write through the
    // raw sessions repo. We deliberately keep this surface tiny — a future
    // SessionStore.updateMeta() would replace this direct repo call.
    const row = this.deps.sessions.findById(sessionId);
    if (!row) return;
    const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
    meta[SURFACED_META_KEY] = surfaced;

    // No repo helper for meta — use raw SQL via the underlying db.
    // (Avoids leaking storage internals; the alternative is plumbing a method
    // through SessionStore, which we can do once more callers need it.)
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
