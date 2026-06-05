import type {
  MemoryNodeRow, MemoryEdgeRow, MemoryItemRow,
  MemoryNodeType, MemoryItemKind,
} from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';

// ── Browse filters (UI memory panel) ─────────────────────────────────────────

export interface BrowseNodesOptions {
  limit?:        number;
  nodeType?:     MemoryNodeType;
  minImportance?: number;
  /** Order by `last_referenced_at` DESC (default) or `importance` DESC. */
  orderBy?:      'lastRef' | 'importance' | 'created';
  search?:       string;     // LIKE on label/description
}

export interface BrowseItemsOptions {
  limit?:        number;
  kind?:         MemoryItemKind;
  mode?:         string;
  minImportance?: number;
  orderBy?:      'lastRef' | 'importance' | 'created';
  search?:       string;     // LIKE on title/body
}

// ── Listers ──────────────────────────────────────────────────────────────────

export function browseNodes(
  deps: MemoryDeps,
  opts: BrowseNodesOptions = {},
): MemoryNodeRow[] {
  return deps.nodes.browse(opts);
}

export function browseItems(
  deps: MemoryDeps,
  opts: BrowseItemsOptions = {},
): MemoryItemRow[] {
  return deps.items.browse(opts);
}

/** Edges incident to any node id in `nodeIds`. Useful for graph rendering. */
export function browseEdgesForNodes(
  deps: MemoryDeps,
  nodeIds: string[],
): MemoryEdgeRow[] {
  return deps.edges.listForNodes(nodeIds);
}
