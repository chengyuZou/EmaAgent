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
  backgroundTasks: {
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
  const db = deps.db.sqlite;

  // ── Nodes ───────────────────────────────────────────────────────────────────
  const nodeRows = db.prepare(
    `SELECT node_type, COUNT(*) AS n, AVG(importance) AS avg_imp,
            MIN(last_referenced_at) AS oldest, MAX(last_referenced_at) AS newest,
            SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
       FROM memory_nodes
      GROUP BY node_type`,
  ).all() as Array<{
    node_type: MemoryNodeType; n: number; avg_imp: number | null;
    oldest: number | null; newest: number | null; embedded: number;
  }>;

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
    byNodeType[r.node_type] = r.n;
    totalNodes    += r.n;
    embeddedNodes += r.embedded;
    if (r.avg_imp !== null) weightedImp += r.avg_imp * r.n;
    if (r.oldest !== null) oldestRef = oldestRef === null ? r.oldest : Math.min(oldestRef, r.oldest);
    if (r.newest !== null) newestRef = newestRef === null ? r.newest : Math.max(newestRef, r.newest);
  }
  const staleNodeEmbeds = currentEmbedProviderId
    ? deps.nodes.countStaleEmbeddings(currentEmbedProviderId)
    : 0;

  // ── Items ───────────────────────────────────────────────────────────────────
  const itemRows = db.prepare(
    `SELECT kind, COUNT(*) AS n, AVG(importance) AS avg_imp,
            SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
       FROM memory_items
      WHERE expires_at IS NULL OR expires_at > ?
      GROUP BY kind`,
  ).all(Date.now()) as Array<{
    kind: MemoryItemKind; n: number; avg_imp: number | null; embedded: number;
  }>;
  const byItemKind = { user: 0, feedback: 0, project: 0, reference: 0 } as Record<MemoryItemKind, number>;
  let totalItems = 0;
  let embeddedItems = 0;
  let itemImpSum = 0;
  for (const r of itemRows) {
    byItemKind[r.kind] = r.n;
    totalItems    += r.n;
    embeddedItems += r.embedded;
    if (r.avg_imp !== null) itemImpSum += r.avg_imp * r.n;
  }
  const staleItemEmbeds = currentEmbedProviderId
    ? deps.items.countStaleEmbeddings(currentEmbedProviderId)
    : 0;

  // ── Edges ───────────────────────────────────────────────────────────────────
  const edgeRow = db.prepare(
    `SELECT COUNT(*) AS n, AVG(mention_count) AS avg_m, MAX(mention_count) AS max_m
       FROM memory_edges`,
  ).get() as { n: number; avg_m: number | null; max_m: number | null };

  // ── Lazy updates ────────────────────────────────────────────────────────────
  const lazyTotal = db.prepare(
    `SELECT COUNT(*) AS n FROM memory_node_lazy_updates`,
  ).get() as { n: number };
  const lazyNodes = deps.lazyUpdates.listNodesWithPending().length;

  // ── Session notes ───────────────────────────────────────────────────────────
  const notesRow = db.prepare(
    `SELECT COUNT(*) AS n, SUM(LENGTH(body)) AS chars FROM session_notes`,
  ).get() as { n: number; chars: number | null };

  // ── Background tasks ────────────────────────────────────────────────────────
  const taskRows = db.prepare(
    `SELECT status, COUNT(*) AS n FROM background_tasks GROUP BY status`,
  ).all() as Array<{ status: string; n: number }>;
  const tasks = { pending: 0, running: 0, completed: 0, failed: 0 };
  for (const r of taskRows) {
    if (r.status in tasks) (tasks as Record<string, number>)[r.status] = r.n;
  }

  // ── Pending fragments ───────────────────────────────────────────────────────
  const pendingSessions = deps.pendingFragments.listSessionsWithPending().length;

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
      total:           edgeRow.n,
      avgMentionCount: edgeRow.avg_m ?? 0,
      maxMentionCount: edgeRow.max_m ?? 0,
    },
    lazyUpdates: {
      totalRows:         lazyTotal.n,
      nodesWithPending:  lazyNodes,
    },
    sessionNotes: {
      totalSessions:  notesRow.n,
      totalChars:     notesRow.chars ?? 0,
    },
    backgroundTasks: tasks,
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
