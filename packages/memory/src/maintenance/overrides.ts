import type { SessionId } from '@ema-agent/contracts';
import type { SessionsRepo, SqliteDb } from '@ema-agent/storage';

// ── Per-session memory overrides ─────────────────────────────────────────────

/**
 * User-controllable knobs for one specific session. All fields default to
 * `true` — i.e. no override = full memory behaviour as configured globally.
 *
 * Read controls (which layers contribute to the next recall):
 *   layer0       — global identity graph
 *   layer1       — session summary
 *   layer2       — episodic items
 *   narrative    — LightRAG narrative recall (narrative mode only)
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
  narrative?:     boolean;
  extraction?:    boolean;
  consolidation?: boolean;
  compaction?:    boolean;
}

export interface ResolvedSessionOverrides {
  layer0:        boolean;
  layer1:        boolean;
  layer2:        boolean;
  narrative:     boolean;
  extraction:    boolean;
  consolidation: boolean;
  compaction:    boolean;
}

const OVERRIDES_META_KEY = 'memory.overrides';

export const DEFAULT_OVERRIDES: ResolvedSessionOverrides = {
  layer0:        true,
  layer1:        true,
  layer2:        true,
  narrative:     true,
  extraction:    true,
  consolidation: true,
  compaction:    true,
};

// ── Read / write ──────────────────────────────────────────────────────────────

export function readOverrides(
  repo: SessionsRepo,
  sessionId: SessionId,
): ResolvedSessionOverrides {
  const row = repo.findById(sessionId);
  if (!row) return DEFAULT_OVERRIDES;
  const meta = safeParseMeta(row.meta_json);
  const stored = meta[OVERRIDES_META_KEY];
  if (!stored || typeof stored !== 'object') return DEFAULT_OVERRIDES;
  return resolveOverrides(stored as MemorySessionOverrides);
}

export function writeOverrides(
  repo: SessionsRepo,
  sessionId: SessionId,
  overrides: MemorySessionOverrides,
  db: SqliteDb,
): void {
  const row = repo.findById(sessionId);
  if (!row) return;
  const meta = safeParseMeta(row.meta_json);
  meta[OVERRIDES_META_KEY] = overrides;
  db.prepare('UPDATE sessions SET meta_json = ? WHERE id = ?')
    .run(JSON.stringify(meta), sessionId);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveOverrides(partial: MemorySessionOverrides): ResolvedSessionOverrides {
  return {
    layer0:        partial.layer0        ?? DEFAULT_OVERRIDES.layer0,
    layer1:        partial.layer1        ?? DEFAULT_OVERRIDES.layer1,
    layer2:        partial.layer2        ?? DEFAULT_OVERRIDES.layer2,
    narrative:     partial.narrative     ?? DEFAULT_OVERRIDES.narrative,
    extraction:    partial.extraction    ?? DEFAULT_OVERRIDES.extraction,
    consolidation: partial.consolidation ?? DEFAULT_OVERRIDES.consolidation,
    compaction:    partial.compaction    ?? DEFAULT_OVERRIDES.compaction,
  };
}

function safeParseMeta(json: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
