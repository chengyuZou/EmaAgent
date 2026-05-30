import type { MemoryItemRow } from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type {
  EpisodicRecallResult, RecalledItem, MemorySettings, EmbeddedText,
} from '../types.js';
import { dotProduct, unpackEmbedding } from '../embed/similarity.js';
import type { VectorIndex } from '../index/vector-index.js';

// ── Mode-weighted recall ─────────────────────────────────────────────────────

interface RecallLayer2Args {
  query:           string;
  queryVec:        Float32Array | null;
  queryEmbed:      EmbeddedText | null;
  index:           VectorIndex | null;
  mode:            'chat' | 'agent';
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
  const { mode, queryVec, queryEmbed, index, alreadySurfaced, settings } = args;
  const K       = settings.recall.layer2TopK;
  const w       = settings.recall.currentModeWeight;
  const curSlot = Math.max(1, Math.ceil(K * w));
  const othSlot = Math.max(0, K - curSlot);
  const otherMode: 'chat' | 'agent' = mode === 'chat' ? 'agent' : 'chat';

  // ── Vector path ──────────────────────────────────────────────────────────
  if (queryVec && queryEmbed) {
    const ranked = rankByVector(
      deps, queryVec, queryEmbed, index, alreadySurfaced, K * 4,
    );

    const currentMode = ranked
      .filter(r => parseModes(r.modes_json).includes(mode))
      .slice(0, curSlot)
      .map(toRecalledItem);

    const otherModes = ranked
      .filter(r => parseModes(r.modes_json).includes(otherMode)
                 && !currentMode.some(c => c.id === r.id))
      .slice(0, othSlot)
      .map(toRecalledItem);

    return { currentMode, otherModes };
  }

  // ── Heuristic fallback ───────────────────────────────────────────────────
  const currentPool = deps.items.listByMode(mode, 500);
  const otherPool   = deps.items.listByMode(otherMode, 500);
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
  const rows = deps.items.listEmbeddable(queryEmbed.model);
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

function parseModes(json: string): string[] {
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
  };
}
