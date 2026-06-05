import type { MemoryDeps } from '../deps.js';
import type { MemoryNodeType, MemoryItemKind } from '@ema-agent/storage';
import type { VectorIndex } from '../index/vector-index.js';

// ── Stats shape (consumed by UI memory panel) ────────────────────────────────

export interface MemoryStats {
  nodes: {
    total:             number;
    byType:            Record<MemoryNodeType, number>;
    embeddedCount:     number;
    staleEmbedCount:   number;
    avgImportance:     number;
    oldestRefAt:       number | null;     // unix ms
    newestRefAt:       number | null;
  };
  items: {
    total:             number;
    byKind:            Record<MemoryItemKind, number>;
    embeddedCount:     number;
    staleEmbedCount:   number;
    avgImportance:     number;
  };
  edges: {
    total:             number;
    avgMentionCount:   number;
    maxMentionCount:   number;
  };
  lazyUpdates: {
    totalRows:         number;
    nodesWithPending:  number;
  };
  sessionNotes: {
    totalSessions:     number;
    totalChars:        number;
  };
  memoryTasks: {
    pending:           number;
    running:           number;
    completed:         number;
    failed:            number;
  };
  pendingFragments: {
    sessionCount:      number;
  };
  index: {
    nodes: { size: number; backend: string } | null;
    items: { size: number; backend: string } | null;
  };
}

// ── Aggregator ───────────────────────────────────────────────────────────────

export function collectStats(
  deps: MemoryDeps,
  indexes: {
    nodesIndex: VectorIndex | null;
    itemsIndex: VectorIndex | null;
  },
  currentEmbedProviderId: string | null,
): MemoryStats {
  const now = Date.now();

  // ── Nodes ───────────────────────────────────────────────────────────────────
  const nodeRows = deps.nodes.statsByType();

  const byNodeType = {
    user_fact: 0, entity: 0, event: 0,
    emotion: 0, preference: 0, relationship: 0,
  } as Record<MemoryNodeType, number>;
  let totalNodes = 0;
  let embeddedNodes = 0;
  let weightedImp = 0;
  let oldestRef: number | null = null;
  let newestRef: number | null = null;
  for (const r of nodeRows) {
    byNodeType[r.node_type] = r.total;
    totalNodes    += r.total;
    embeddedNodes += r.embedded_count;
    if (r.avg_importance !== null) weightedImp += r.avg_importance * r.total;
    if (r.oldest_ref_at !== null) oldestRef = oldestRef === null ? r.oldest_ref_at : Math.min(oldestRef, r.oldest_ref_at);
    if (r.newest_ref_at !== null) newestRef = newestRef === null ? r.newest_ref_at : Math.max(newestRef, r.newest_ref_at);
  }
  const staleNodeEmbeds = currentEmbedProviderId
    ? deps.nodes.countStaleEmbeddings(currentEmbedProviderId)
    : 0;

  // ── Items ───────────────────────────────────────────────────────────────────
  const itemRows = deps.items.statsByKind(now);
  const byItemKind = { user: 0, feedback: 0, project: 0, reference: 0 } as Record<MemoryItemKind, number>;
  let totalItems = 0;
  let embeddedItems = 0;
  let itemImpSum = 0;
  for (const r of itemRows) {
    byItemKind[r.kind] = r.total;
    totalItems    += r.total;
    embeddedItems += r.embedded_count;
    if (r.avg_importance !== null) itemImpSum += r.avg_importance * r.total;
  }
  const staleItemEmbeds = currentEmbedProviderId
    ? deps.items.countStaleEmbeddings(currentEmbedProviderId)
    : 0;

  // ── Edges ───────────────────────────────────────────────────────────────────
  const edgeStats = deps.edges.stats();

  // ── Lazy updates ────────────────────────────────────────────────────────────
  const lazyTotal = deps.lazyUpdates.countAll();
  const lazyNodes = deps.lazyUpdates.listNodesWithPending().length;

  // ── Session notes ───────────────────────────────────────────────────────────
  const notesStats = deps.sessionNotes.stats();

  // ── Memory tasks ────────────────────────────────────────────────────────────
  const tasks = deps.memoryTasks.countAllByStatus();

  // ── Pending fragments ───────────────────────────────────────────────────────
  const pendingSessions = deps.pendingFragments.countSessionsWithPending();

  return {
    nodes: {
      total:           totalNodes,
      byType:          byNodeType,
      embeddedCount:   embeddedNodes,
      staleEmbedCount: staleNodeEmbeds,
      avgImportance:   totalNodes === 0 ? 0 : weightedImp / totalNodes,
      oldestRefAt:     oldestRef,
      newestRefAt:     newestRef,
    },
    items: {
      total:           totalItems,
      byKind:          byItemKind,
      embeddedCount:   embeddedItems,
      staleEmbedCount: staleItemEmbeds,
      avgImportance:   totalItems === 0 ? 0 : itemImpSum / totalItems,
    },
    edges: {
      total:           edgeStats.total,
      avgMentionCount: edgeStats.avg_mention_count ?? 0,
      maxMentionCount: edgeStats.max_mention_count ?? 0,
    },
    lazyUpdates: {
      totalRows:         lazyTotal,
      nodesWithPending:  lazyNodes,
    },
    sessionNotes: {
      totalSessions:  notesStats.total_sessions,
      totalChars:     notesStats.total_chars ?? 0,
    },
    memoryTasks: tasks,
    pendingFragments: { sessionCount: pendingSessions },
    index: {
      nodes: indexes.nodesIndex
        ? { size: indexes.nodesIndex.size(), backend: indexes.nodesIndex.backend }
        : null,
      items: indexes.itemsIndex
        ? { size: indexes.itemsIndex.size(), backend: indexes.itemsIndex.backend }
        : null,
    },
  };
}
