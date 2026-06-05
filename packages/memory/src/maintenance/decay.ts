import type { MemoryDeps } from '../deps.js';
import type { MemoryNodeType } from '@ema-agent/storage';

// ── Options + report ─────────────────────────────────────────────────────────

export interface MaintenanceOptions {
  /** Nothing referenced in the last N days becomes a decay candidate. */
  decayAfterDays:     number;
  /** Importance points removed per maintenance run on candidates. */
  decayAmount:        number;
  /** Whether to also decay memory_items along with nodes. */
  decayItems:         boolean;
  /**
   * Dry run mode — compute counts/preview but do NOT mutate anything.
   * UI surfaces this before letting the user click "Run maintenance".
   */
  dryRun:             boolean;
  nowMs:              number;   // for testing only, defaults to Date.now()
}


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
  opts: MaintenanceOptions,
): MaintenanceReport {
  const t0 = Date.now();
  const cutoff = opts.nowMs - opts.decayAfterDays * 24 * 60 * 60 * 1000;

  const nodeCandidates = deps.nodes.listDecayCandidates(cutoff);
  const itemCandidates = opts.decayItems
    ? deps.items.listDecayCandidates(cutoff, opts.nowMs)
    : [];

  const preview: MaintenancePreview = {
    nodes: nodeCandidates.map((n) => ({
      id: n.id,
      label: n.label,
      nodeType: n.node_type,
      currentImportance: n.importance,
      newImportance: Math.max(0, n.importance - opts.decayAmount),
    })),
    items: itemCandidates.map((i) => ({
      id: i.id,
      title: i.title,
      currentImportance: i.importance,
      newImportance: Math.max(0, i.importance - opts.decayAmount),
    })),
    decayedAt: opts.nowMs,
  };

  if (!opts.dryRun) {
    deps.nodes.applyImportanceUpdates(
      preview.nodes.map((n) => ({
        id: n.id,
        importance: n.newImportance,
        updatedAt: opts.nowMs,
      })),
    );
    deps.items.applyImportanceUpdates(
      preview.items.map((i) => ({
        id: i.id,
        importance: i.newImportance,
        updatedAt: opts.nowMs,
      })),
    );
  }

  deps.emit?.({
    type: 'memory_maintenance_completed',
    decayedNodes: opts.dryRun ? 0 : preview.nodes.length,
    decayedItems: opts.dryRun ? 0 : preview.items.length,
    dryRun: opts.dryRun,
    durationMs: Date.now() - t0,
  });

  return {
    dryRun: opts.dryRun,
    decayedNodes: opts.dryRun ? 0 : preview.nodes.length,
    decayedItems: opts.dryRun ? 0 : preview.items.length,
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
