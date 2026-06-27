import type { MemoryNodeRow, MemoryEdgeRow } from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type {
  GraphRecallResult, RecalledNode, RecalledEdge,
  MemorySettings, EmbeddedText,
} from '../types.js';
import { dotProduct, unpackEmbedding } from '../embed/similarity.js';
import type { VectorIndex } from '../vector-index/vector-index.js';

// ── Layer 0 recall ────────────────────────────────────────────────────────────

interface Layer0Args {
  queryVec:        Float32Array | null;    // normalized; null if embed unavailable
  queryEmbed:      EmbeddedText | null;    // provider provenance + dim
  index:           VectorIndex | null;     // null → fall back to DB scan
  alreadySurfaced: Set<string>;
  settings:        MemorySettings;
}

/**
 * Layer-0 entity graph recall.
 *
 *   1. Anchor selection — ANN via VectorIndex when available, otherwise a DB
 *      scan with brute-force cosine sim. Excludes alreadySurfaced.
 *   2. BFS expansion — 1 hop first; if budget not yet filled, 2 hops; never
 *      beyond 2 (noisy). Neighbours ordered by edge weight = log(1 + count).
 *   3. Cap total at `layer0TotalBudget`.
 *
 * Returns an empty result when no anchors can be found (no embed provider AND
 * no LLM-NER anchor strategy implemented yet).
 */
export function recallGraph(
  deps: MemoryDeps,
  args: Layer0Args,
): GraphRecallResult {
  const { queryVec, queryEmbed, index, alreadySurfaced, settings } = args;
  const totalBudget = settings.recall.layer0TotalBudget;
  const anchorK     = settings.recall.layer0AnchorTopK;
  const maxHop      = settings.recall.maxHopDistance;

  if (!queryVec || !queryEmbed) return { nodes: [], edges: [] };

  // ── 1. Anchors via index (fast path) or DB scan (fallback) ────────────────
  const anchorHits = findAnchors(
    deps, queryVec, queryEmbed, index, alreadySurfaced, anchorK,
  );
  if (anchorHits.length === 0) return { nodes: [], edges: [] };

  const topScore = anchorHits[0]!.score;

  // Skip L0 entirely when the query is semantically distant from all nodes
  // (social noise, cold start, greetings). Threshold from settings.
  if (topScore < settings.recall.layer0AnchorMinScore) return { nodes: [], edges: [] };

  // Reduce TopK when relevance is borderline — fewer anchors, less noise.
  const effectiveBudget = topScore < settings.recall.layer0AnchorConfidentScore
    ? Math.max(1, Math.ceil(totalBudget / 2))
    : totalBudget;

  const anchorIds = anchorHits.map(h => h.id);

  // Load anchor rows in one go
  const visited = new Map<string, RecalledNode>();
  for (const id of anchorIds) {
    const row = deps.nodes.findById(id);
    if (row) visited.set(id, toRecalledNode(row, 0));
  }
  if (visited.size === 0) return { nodes: [], edges: [] };

  // ── 2. BFS expansion ──────────────────────────────────────────────────────
  const collectedEdges = new Map<string, RecalledEdge>();
  let frontier: string[] = [...visited.keys()];

  for (let hop = 1; hop <= maxHop; hop++) {
    if (visited.size >= effectiveBudget) break;
    if (frontier.length === 0)       break;

    const edges      = deps.edges.listForNodes(frontier);
    const nextFrontier: string[] = [];

    const weighted = edges.map(e => ({ edge: e, weight: edgeWeight(e) }));
    weighted.sort((a, b) => b.weight - a.weight);

    for (const { edge, weight } of weighted) {
      if (visited.size >= effectiveBudget) break;

      const edgeKey = `${edge.from_node_id}|${edge.relation}|${edge.to_node_id}`;
      if (!collectedEdges.has(edgeKey)) {
        collectedEdges.set(edgeKey, {
          from:     edge.from_node_id,
          to:       edge.to_node_id,
          relation: edge.relation,
          weight,
        });
      }

      const newId = visited.has(edge.from_node_id)
        ? edge.to_node_id
        : visited.has(edge.to_node_id) ? edge.from_node_id
        : null;
      if (!newId) continue;
      if (visited.has(newId)) continue;
      if (alreadySurfaced.has(newId)) continue;

      const row = deps.nodes.findById(newId);
      if (!row) continue;

      visited.set(newId, toRecalledNode(row, hop));
      nextFrontier.push(newId);
    }
    frontier = nextFrontier;
  }

  // Strip dangling edges (other end didn't make the budget cut)
  const finalEdges: RecalledEdge[] = [];
  for (const e of collectedEdges.values()) {
    if (visited.has(e.from) && visited.has(e.to)) finalEdges.push(e);
  }

  return { nodes: [...visited.values()], edges: finalEdges };
}

// ── Anchor finding ───────────────────────────────────────────────────────────

interface AnchorHit { id: string; score: number }

function findAnchors(
  deps: MemoryDeps,
  queryVec: Float32Array,
  queryEmbed: EmbeddedText,
  index: VectorIndex | null,
  alreadySurfaced: Set<string>,
  k: number,
): AnchorHit[] {
  // Fast path: vector index ANN search
  if (index && index.dim === queryEmbed.dim) {
    const overscan = Math.max(k * 3, k + 10);
    const hits = index.search(queryVec, overscan);
    const out: AnchorHit[] = [];
    for (const hit of hits) {
      if (alreadySurfaced.has(hit.id)) continue;
      if (hit.score <= 0)              continue;
      out.push({ id: hit.id, score: hit.score });
      if (out.length >= k) break;
    }
    return out;
  }

  // Fallback: scan DB rows + brute-force cosine
  const rows = deps.nodes.listEmbeddable(queryEmbed.model);
  type Scored = { id: string; score: number };
  const scored: Scored[] = [];
  for (const row of rows) {
    if (alreadySurfaced.has(row.id))          continue;
    if (!row.embedding)                       continue;
    if (row.embedding_dim !== queryEmbed.dim) continue;
    const vec = unpackEmbedding(row.embedding, queryEmbed.dim);
    const score = dotProduct(queryVec, vec);
    if (score <= 0) continue;
    scored.push({ id: row.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function edgeWeight(edge: MemoryEdgeRow): number {
  return Math.log1p(edge.mention_count);
}

function toRecalledNode(row: MemoryNodeRow, hopDistance: number): RecalledNode {
  return {
    id:          row.id,
    label:       row.label,
    nodeType:    row.node_type,
    description: row.description,
    importance:  row.importance,
    hopDistance,
  };
}
