import type { SessionId } from '@ema-agent/contracts';
import type { MemorySessionStateRepo } from '@ema-agent/storage';

// ── Per-session memory overrides ─────────────────────────────────────────────

/**
 * User-controllable knobs for one specific session. All fields default to
 * `true` — i.e. no override = full memory behaviour as configured globally.
 *
 * Read controls (which layers contribute to the next recall):
 *   layer0       — global identity graph
 *   layer1       — session summary
 *   layer2       — episodic items
 *
 * Write controls (whether this session feeds back into memory):
 *   extraction    — append to pending_fragments + run extraction LLM
 *   consolidation — drain lazy_updates into node descriptions
 *   compaction    — micro/macro compaction during beforeLlm
 *
 * Empty object means "use all defaults" (everything on).
 */
export interface MemorySessionOverrides {
  layer0?:        boolean;
  layer1?:        boolean;
  layer2?:        boolean;
  extraction?:    boolean;
  consolidation?: boolean;
  compaction?:    boolean;
}

export interface ResolvedSessionOverrides {
  layer0:        boolean;
  layer1:        boolean;
  layer2:        boolean;
  extraction:    boolean;
  consolidation: boolean;
  compaction:    boolean;
}

export const DEFAULT_OVERRIDES: ResolvedSessionOverrides = {
  layer0:        true,
  layer1:        true,
  layer2:        true,
  extraction:    true,
  consolidation: true,
  compaction:    true,
};

// ── Read / write ──────────────────────────────────────────────────────────────

export function readOverrides(
  repo:      MemorySessionStateRepo,
  sessionId: SessionId,
): ResolvedSessionOverrides {
  const stored = repo.getOverrides(sessionId);
  if (!stored || typeof stored !== 'object' || Object.keys(stored).length === 0) {
    return DEFAULT_OVERRIDES;
  }
  return resolveOverrides(stored as MemorySessionOverrides);
}

export function writeOverrides(
  repo:      MemorySessionStateRepo,
  sessionId: SessionId,
  overrides: MemorySessionOverrides,
): void {
  repo.setOverrides(sessionId, overrides as Record<string, unknown>);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveOverrides(partial: MemorySessionOverrides): ResolvedSessionOverrides {
  return {
    layer0:        partial.layer0        ?? DEFAULT_OVERRIDES.layer0,
    layer1:        partial.layer1        ?? DEFAULT_OVERRIDES.layer1,
    layer2:        partial.layer2        ?? DEFAULT_OVERRIDES.layer2,
    extraction:    partial.extraction    ?? DEFAULT_OVERRIDES.extraction,
    consolidation: partial.consolidation ?? DEFAULT_OVERRIDES.consolidation,
    compaction:    partial.compaction    ?? DEFAULT_OVERRIDES.compaction,
  };
}
