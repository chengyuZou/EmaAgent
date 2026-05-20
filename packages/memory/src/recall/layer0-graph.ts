import type { MemoryNodeRow, MemoryEdgeRow } from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type {
  GraphRecallResult, RecalledNode, RecalledEdge,
  MemorySettings, EmbeddedText,
} from '../types.js';
import { cosineSim, unpackEmbedding } from '../embed/similarity.js';

// ── Layer 0 recall ────────────────────────────────────────────────────────────

interface Layer0Args {
  queryEmbed:      EmbeddedText | null;
  alreadySurfaced: Set<string>;
  settings:        MemorySettings;
}

/**
 * Layer-0 entity graph recall. Steps:
 *
 *   1. Anchor selection — cosine sim against the user message; take top
 *      `layer0AnchorTopK`, excluding recently surfaced.
 *   2. BFS expansion — 1 hop first; if budget not filled, 2 hop.
 *      Never beyond 2 hops (empirically too noisy). Neighbours are ordered
 *      by edge weight (log(1 + mention_count)) descending.
 *   3. Cap total at `layer0TotalBudget`.
 *
 * Returns empty result when no embed provider is configured AND no anchor
 * detection fallback is implemented yet (V1 only does embedding-based anchors).
 */
export function recallGraph(
  deps: MemoryDeps,
  args: Layer0Args,
): GraphRecallResult {
  const { queryEmbed, alreadySurfaced, settings } = args;
  const totalBudget = settings.recall.layer0TotalBudget;
  const anchorK     = settings.recall.layer0AnchorTopK;
  const maxHop      = settings.recall.maxHopDistance;

  // ── 1. Anchors ──────────────────────────────────────────────────────────────
  // For V1 we only implement the embedding-based anchor strategy. Hybrid
  // (LLM-NER + embedding) lands in a later pass; until then the planner can
  // pre-select using LLM-NER and stuff anchors into a future override field.
  if (!queryEmbed) return { nodes: [], edges: [] };

  const candidates = deps.nodes.listEmbeddable(queryEmbed.providerId);
  const queryVec   = unpackEmbedding(queryEmbed.embedding, queryEmbed.dim);

  type Scored = { node: MemoryNodeRow; score: number };
  const scored: Scored[] = [];
  for (const node of candidates) {
    if (alreadySurfaced.has(node.id)) continue;
    if (!node.embedding) continue;
    if (node.embedding_dim !== queryEmbed.dim) continue;
    const vec   = unpackEmbedding(node.embedding, queryEmbed.dim);
    const score = cosineSim(queryVec, vec);
    if (score <= 0) continue;
    scored.push({ node, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const anchors = scored.slice(0, anchorK).map(s => s.node);
  if (anchors.length === 0) return { nodes: [], edges: [] };

  // ── 2. BFS expansion ───────────────────────────────────────────────────────
  const visited = new Map<string, RecalledNode>();
  const collectedEdges = new Map<string, RecalledEdge>();

  for (const anchor of anchors) {
    visited.set(anchor.id, toRecalledNode(anchor, 0));
  }

  let frontier = anchors.map(a => a.id);
  for (let hop = 1; hop <= maxHop; hop++) {
    if (visited.size >= totalBudget) break;
    if (frontier.length === 0) break;

    const edges       = deps.edges.listForNodes(frontier);
    const nextFrontier: string[] = [];

    // Sort edges by weight DESC so high-importance neighbours arrive first
    const weighted = edges.map(e => ({ edge: e, weight: edgeWeight(e) }));
    weighted.sort((a, b) => b.weight - a.weight);

    for (const { edge, weight } of weighted) {
      if (visited.size >= totalBudget) break;

      // Always remember the edge if both ends are or will be in the recall set,
      // so the rendered graph shows connections.
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

  // Strip edges whose both endpoints didn't end up in the visited set —
  // happens when budget filled before neighbour was added.
  const finalEdges: RecalledEdge[] = [];
  for (const e of collectedEdges.values()) {
    if (visited.has(e.from) && visited.has(e.to)) finalEdges.push(e);
  }

  return {
    nodes: [...visited.values()],
    edges: finalEdges,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function edgeWeight(edge: MemoryEdgeRow): number {
  // log1p(mention_count). Recent edges get a tiny tiebreaker boost via floor.
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
