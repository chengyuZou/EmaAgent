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
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (opts.nodeType) {
    where.push('node_type = ?');
    params.push(opts.nodeType);
  }
  if (typeof opts.minImportance === 'number') {
    where.push('importance >= ?');
    params.push(opts.minImportance);
  }
  if (opts.search) {
    where.push('(label LIKE ? OR description LIKE ?)');
    const pat = `%${opts.search}%`;
    params.push(pat, pat);
  }

  const orderCol = opts.orderBy === 'importance' ? 'importance DESC'
                 : opts.orderBy === 'created'    ? 'created_at DESC'
                 :                                  'last_referenced_at DESC';

  const sql =
    `SELECT * FROM memory_nodes` +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ${orderCol} LIMIT ?`;
  params.push(opts.limit ?? 100);

  return deps.db.sqlite.prepare(sql).all(...params) as MemoryNodeRow[];
}

export function browseItems(
  deps: MemoryDeps,
  opts: BrowseItemsOptions = {},
): MemoryItemRow[] {
  const where: string[] = ['(expires_at IS NULL OR expires_at > ?)'];
  const params: Array<string | number> = [Date.now()];

  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }
  if (typeof opts.minImportance === 'number') {
    where.push('importance >= ?');
    params.push(opts.minImportance);
  }
  if (opts.search) {
    where.push('(title LIKE ? OR body LIKE ?)');
    const pat = `%${opts.search}%`;
    params.push(pat, pat);
  }
  if (opts.mode) {
    where.push(
      `EXISTS (SELECT 1 FROM json_each(modes_json) WHERE json_each.value = ?)`,
    );
    params.push(opts.mode);
  }

  const orderCol = opts.orderBy === 'importance' ? 'importance DESC'
                 : opts.orderBy === 'created'    ? 'created_at DESC'
                 :                                  'last_referenced_at DESC';

  const sql =
    `SELECT * FROM memory_items WHERE ${where.join(' AND ')}` +
    ` ORDER BY ${orderCol} LIMIT ?`;
  params.push(opts.limit ?? 100);

  return deps.db.sqlite.prepare(sql).all(...params) as MemoryItemRow[];
}

/** Edges incident to any node id in `nodeIds`. Useful for graph rendering. */
export function browseEdgesForNodes(
  deps: MemoryDeps,
  nodeIds: string[],
): MemoryEdgeRow[] {
  return deps.edges.listForNodes(nodeIds);
}
