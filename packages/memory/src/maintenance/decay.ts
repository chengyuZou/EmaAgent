import type { MemoryDeps } from '../deps.js';
import type { MemoryNodeType } from '@ema-agent/storage';

// ── Options + report ─────────────────────────────────────────────────────────

export interface MaintenanceOptions {
  /** Nothing referenced in the last N days becomes a decay candidate. */
  decayAfterDays:     number;
  /** Importance points removed per maintenance run on candidates. */
  decayAmount:        number;
  /** Node types that are NEVER auto-decayed (identity is sacred). */
  protectedNodeTypes: MemoryNodeType[];
  /** Whether to also decay memory_items along with nodes. */
  decayItems:         boolean;
  /**
   * Dry run mode — compute counts/preview but do NOT mutate anything.
   * UI surfaces this before letting the user click "Run maintenance".
   */
  dryRun:             boolean;
}

export const DEFAULT_MAINTENANCE: MaintenanceOptions = {
  decayAfterDays:     30,
  decayAmount:        5,
  protectedNodeTypes: ['user_fact', 'preference', 'relationship'],
  decayItems:         true,
  dryRun:             true,
};

export interface MaintenancePreview {
  nodes: { id: string; label: string; nodeType: MemoryNodeType; currentImportance: number; newImportance: number }[];
  items: { id: string; title: string; currentImportance: number; newImportance: number }[];
  decayedAt: number;
}

export interface MaintenanceReport {
  dryRun:           boolean;
  decayedNodes:     number;
  decayedItems:     number;
  preview:          MaintenancePreview;
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Run an importance-decay pass. Nodes / items whose `last_referenced_at` is
 * older than `decayAfterDays` get their `importance` reduced by `decayAmount`.
 *
 * Protected node types (default: user_fact / preference / relationship) are
 * NEVER decayed — Ema must keep knowing who you are.
 *
 * `dryRun: true` returns the list of rows that WOULD be touched without
 * mutating anything. Use that to render a preview in the UI before the user
 * commits to a real run.
 */
export function runMaintenance(
  deps: MemoryDeps,
  opts: Partial<MaintenanceOptions> = {},
): MaintenanceReport {
  const cfg = { ...DEFAULT_MAINTENANCE, ...opts };
  const cutoff = Date.now() - cfg.decayAfterDays * 24 * 60 * 60 * 1000;
  const db = deps.db.sqlite;

  // ── Candidate selection ───────────────────────────────────────────────────
  const protectedClause = cfg.protectedNodeTypes.length === 0
    ? ''
    : `AND node_type NOT IN (${cfg.protectedNodeTypes.map(() => '?').join(',')})`;
  const nodeCandidates = db.prepare(
    `SELECT id, label, node_type, importance
       FROM memory_nodes
      WHERE last_referenced_at < ? AND importance > 0 ${protectedClause}`,
  ).all(cutoff, ...cfg.protectedNodeTypes) as Array<{
    id: string; label: string; node_type: MemoryNodeType; importance: number;
  }>;

  const itemCandidates = cfg.decayItems
    ? db.prepare(
        `SELECT id, title, importance
           FROM memory_items
          WHERE last_referenced_at < ? AND importance > 0
            AND (expires_at IS NULL OR expires_at > ?)`,
      ).all(cutoff, Date.now()) as Array<{
        id: string; title: string; importance: number;
      }>
    : [];

  const preview: MaintenancePreview = {
    nodes: nodeCandidates.map(n => ({
      id: n.id, label: n.label, nodeType: n.node_type,
      currentImportance: n.importance,
      newImportance:     Math.max(0, n.importance - cfg.decayAmount),
    })),
    items: itemCandidates.map(i => ({
      id: i.id, title: i.title,
      currentImportance: i.importance,
      newImportance:     Math.max(0, i.importance - cfg.decayAmount),
    })),
    decayedAt: Date.now(),
  };

  if (cfg.dryRun) {
    return {
      dryRun:       true,
      decayedNodes: 0,
      decayedItems: 0,
      preview,
    };
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  const txn = db.transaction(() => {
    if (preview.nodes.length > 0) {
      const stmt = db.prepare(
        `UPDATE memory_nodes
            SET importance = MAX(0, importance - ?), updated_at = ?
          WHERE id = ?`,
      );
      const now = Date.now();
      for (const n of preview.nodes) stmt.run(cfg.decayAmount, now, n.id);
    }
    if (preview.items.length > 0) {
      const stmt = db.prepare(
        `UPDATE memory_items
            SET importance = MAX(0, importance - ?), updated_at = ?
          WHERE id = ?`,
      );
      const now = Date.now();
      for (const i of preview.items) stmt.run(cfg.decayAmount, now, i.id);
    }
  });
  txn();

  return {
    dryRun:       false,
    decayedNodes: preview.nodes.length,
    decayedItems: preview.items.length,
    preview,
  };
}

// ── Hard delete (user-initiated only) ────────────────────────────────────────

/**
 * Hard-delete a node and all its edges. Triggered ONLY by explicit user action
 * in the memory panel — automated maintenance never deletes, only decays.
 */
export function deleteNode(deps: MemoryDeps, nodeId: string): void {
  // ON DELETE CASCADE handles edges + lazy_updates
  deps.nodes.delete(nodeId);
}

export function deleteItem(deps: MemoryDeps, itemId: string): void {
  deps.items.delete(itemId);
}

/**
 * Hard-delete all zero-importance rows that haven't been referenced in
 * `hardDeleteAfterDays`. UI shows confirmation before calling this.
 */
export function hardDeleteZeroImportance(
  deps: MemoryDeps,
  hardDeleteAfterDays: number,
): { deletedNodes: number; deletedItems: number } {
  const cutoff = Date.now() - hardDeleteAfterDays * 24 * 60 * 60 * 1000;
  const db = deps.db.sqlite;

  const delNodes = db.prepare(
    `DELETE FROM memory_nodes WHERE importance = 0 AND last_referenced_at < ?`,
  ).run(cutoff);
  const delItems = db.prepare(
    `DELETE FROM memory_items WHERE importance = 0 AND last_referenced_at < ?`,
  ).run(cutoff);

  return {
    deletedNodes: delNodes.changes,
    deletedItems: delItems.changes,
  };
}
