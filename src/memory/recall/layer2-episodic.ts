import type { MemoryItemRow } from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type { ExecutionProfile } from '@ema-agent/turn-terms';
import type {
  EpisodicRecallResult, RecalledItem, MemorySettings, EmbeddedText,
} from '../types.js';
import { dotProduct, unpackEmbedding } from '../embed/similarity.js';
import type { VectorIndex } from '../vector-index/vector-index.js';

// ── Mode-weighted recall ─────────────────────────────────────────────────────

interface RecallLayer2Args {
  query:           string;
  queryVec:        Float32Array | null;
  queryEmbed:      EmbeddedText | null;
  index:           VectorIndex | null;
  executionProfile: ExecutionProfile;
  alreadySurfaced: Set<string>;
  settings:        MemorySettings;
}

/**
 * Recall memory_items, weighted between the current mode's pool and others.
 *
 *   currentMode slots = ceil(K * w)
 *   otherModes  slots = K - currentMode slots    (w = settings.recall.currentModeWeight)
 *
 * Pipeline:
 *   1. If VectorIndex + query vector available: ANN search (over a generous
 *      overscan), then filter rows by mode tag.
 *   2. If embed unavailable: heuristic ranking by importance + recency.
 *
 * Mode is a soft weight — items tagged with a different mode still surface in
 * the otherModes slice, which is what makes cross-mode memory feel cohesive.
 */
export async function recallEpisodic(
  deps: MemoryDeps,
  args: RecallLayer2Args,
): Promise<EpisodicRecallResult> {
  const { executionProfile, queryVec, queryEmbed, index, alreadySurfaced, settings } = args;
  const K       = settings.recall.layer2TopK;
  const w       = settings.recall.currentModeWeight;
  // Reserve at least 1 slot for cross-mode recall when K allows, so a high
  // currentModeWeight (e.g. 0.9) doesn't fully starve otherModes at small K
  // (previously: K=5, w=0.9 → curSlot=5, othSlot=0, cross-mode shut off).
  const curSlot = K > 1 ? Math.min(Math.max(1, Math.ceil(K * w)), K - 1) : 1;
  const othSlot = Math.max(0, K - curSlot);
  // 给另一种执行 Profile 保留少量配额，避免 Chat 与 Work 的长期事实互相隔绝。
  const otherProfiles: readonly ExecutionProfile[] =
    (['chat', 'work'] as const).filter(candidate => candidate !== executionProfile);

  // ── Vector path ──────────────────────────────────────────────────────────
  if (queryVec && queryEmbed) {
    const ranked = rankByVector(
      deps, queryVec, queryEmbed, index, alreadySurfaced, K * 4,
    );

    const currentMode = ranked
      .filter(r => parseProfiles(r.profiles_json).includes(executionProfile))
      .slice(0, curSlot)
      .map(toRecalledItem);

    const otherModes = ranked
      .filter(r => {
        if (currentMode.some(c => c.id === r.id)) return false;
        return parseProfiles(r.profiles_json).some(candidate => candidate !== executionProfile);
      })
      .slice(0, othSlot)
      .map(toRecalledItem);

    return { currentMode, otherModes };
  }

  // ── Heuristic fallback ───────────────────────────────────────────────────
  const currentPool = deps.items.listByProfile(executionProfile, 500);
  const otherPool   = otherProfiles.flatMap(candidate => deps.items.listByProfile(candidate, 500));
  const currentRanked = rankByHeuristic(currentPool, alreadySurfaced);
  const otherRanked   = rankByHeuristic(otherPool,   alreadySurfaced);

  return {
    currentMode: currentRanked.slice(0, curSlot).map(toRecalledItem),
    otherModes:  otherRanked.slice(0, othSlot).map(toRecalledItem),
  };
}

// ── Vector ranking ───────────────────────────────────────────────────────────

function rankByVector(
  deps: MemoryDeps,
  queryVec: Float32Array,
  queryEmbed: EmbeddedText,
  index: VectorIndex | null,
  alreadySurfaced: Set<string>,
  topN: number,
): MemoryItemRow[] {
  // Fast path: ANN via VectorIndex
  if (index && index.dim === queryEmbed.dim) {
    const hits = index.search(queryVec, topN);
    const out: MemoryItemRow[] = [];
    for (const hit of hits) {
      if (alreadySurfaced.has(hit.id)) continue;
      if (hit.score <= 0)              continue;
      const row = deps.items.findById(hit.id);
      if (!row) continue;
      out.push(row);
    }
    return out;
  }

  // Fallback: DB scan + brute-force dot product
  const rows = deps.items.listEmbeddable(queryEmbed.space.id);
  type Scored = { row: MemoryItemRow; score: number };
  const scored: Scored[] = [];
  for (const row of rows) {
    if (alreadySurfaced.has(row.id))            continue;
    if (!row.embedding)                         continue;
    if (row.embedding_dim !== queryEmbed.dim)   continue;  // guard against malformed data
    const vec = unpackEmbedding(row.embedding, queryEmbed.dim);
    const score = dotProduct(queryVec, vec);
    if (score <= 0) continue;
    scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map(s => s.row);
}

// ── Heuristic fallback ───────────────────────────────────────────────────────

function rankByHeuristic(
  rows: MemoryItemRow[],
  alreadySurfaced: Set<string>,
): MemoryItemRow[] {
  return rows
    .filter(r => !alreadySurfaced.has(r.id))
    .sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.last_referenced_at - a.last_referenced_at;
    });
}

// ── Conversions ──────────────────────────────────────────────────────────────

function parseProfiles(json: string): string[] {
  try { return JSON.parse(json) as string[]; }
  catch { return []; }
}

function toRecalledItem(row: MemoryItemRow): RecalledItem {
  return {
    id:         row.id,
    kind:       row.kind,
    title:      row.title,
    body:       row.body,
    importance: row.importance,
    updatedAt:  row.updated_at,
  };
}
