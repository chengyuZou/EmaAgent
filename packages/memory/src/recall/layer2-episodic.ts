import type { MemoryItemRow } from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type {
  EpisodicRecallResult, RecalledItem, MemorySettings, EmbeddedText,
} from '../types.js';
import { cosineSim, unpackEmbedding } from '../embed/similarity.js';
import { EmbedService } from '../embed/service.js';

// ── Mode-weighted recall ─────────────────────────────────────────────────────

interface RecallLayer2Args {
  query:        string;
  queryEmbed:   EmbeddedText | null;       // null → LLM-side-query fallback path
  mode:         'chat' | 'agent';          // narrative skips Layer 2
  alreadySurfaced: Set<string>;
  settings:     MemorySettings;
}

/**
 * Recall memory_items, weighted between the current mode's pool and other modes.
 *
 *   currentMode slots = ceil(K * w)
 *   otherModes  slots = K - currentMode slots
 *
 * `w` is settings.recall.currentModeWeight. We never hard-filter — items
 * tagged with a different mode can still surface in the otherModes slice,
 * which is what makes "用户 chat 里说的事 agent 也记得" work.
 *
 * Strategy:
 *  1. If embedding available → vector cosine top-K, possibly rerank.
 *  2. If embedding missing   → importance + recency fallback (sort by
 *     importance DESC then last_referenced_at DESC). This degrades gracefully
 *     when ebd-client isn't configured.
 */
export async function recallEpisodic(
  deps: MemoryDeps,
  args: RecallLayer2Args,
): Promise<EpisodicRecallResult> {
  const { mode, queryEmbed, alreadySurfaced, settings } = args;
  const K       = settings.recall.layer2TopK;
  const w       = settings.recall.currentModeWeight;
  const curSlot = Math.max(1, Math.ceil(K * w));
  const othSlot = Math.max(0, K - curSlot);

  // Candidate pools by mode tag
  const currentPool = deps.items.listByMode(mode, 500);
  const otherPool   = mode === 'chat'
    ? deps.items.listByMode('agent', 500)
    : deps.items.listByMode('chat', 500);

  // Vector path
  if (queryEmbed) {
    const queryVec = unpackEmbedding(queryEmbed.embedding, queryEmbed.dim);

    const currentRanked = rankByVector(currentPool, queryVec, queryEmbed, alreadySurfaced);
    const otherRanked   = rankByVector(otherPool,   queryVec, queryEmbed, alreadySurfaced);

    // Reranker is a future enhancement: ebd-client.rerank() over top-20 candidates
    // before cutting to topK. For now we use raw cosine ranking; useReranker is
    // honoured in a later pass once we wire rerank end-to-end.

    return {
      currentMode: currentRanked.slice(0, curSlot).map(toRecalledItem),
      otherModes:  otherRanked.slice(0, othSlot).map(toRecalledItem),
    };
  }

  // Heuristic fallback: importance + recency
  const currentRanked = rankByHeuristic(currentPool, alreadySurfaced);
  const otherRanked   = rankByHeuristic(otherPool,   alreadySurfaced);

  return {
    currentMode: currentRanked.slice(0, curSlot).map(toRecalledItem),
    otherModes:  otherRanked.slice(0, othSlot).map(toRecalledItem),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rankByVector(
  rows: MemoryItemRow[],
  queryVec: Float32Array,
  queryEmbed: EmbeddedText,
  alreadySurfaced: Set<string>,
): MemoryItemRow[] {
  type Scored = { row: MemoryItemRow; score: number };
  const scored: Scored[] = [];

  for (const row of rows) {
    if (alreadySurfaced.has(row.id)) continue;
    // Skip stale embeddings (different provider or missing) — they fall back
    // to the heuristic path by being excluded here.
    if (!row.embedding) continue;
    if (row.embedding_provider_id !== queryEmbed.providerId) continue;
    if (row.embedding_dim !== queryEmbed.dim) continue;

    const vec   = unpackEmbedding(row.embedding, queryEmbed.dim);
    const score = cosineSim(queryVec, vec);
    scored.push({ row, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.row);
}

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

function toRecalledItem(row: MemoryItemRow): RecalledItem {
  return {
    id:         row.id,
    kind:       row.kind,
    title:      row.title,
    body:       row.body,
    importance: row.importance,
  };
}
