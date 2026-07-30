import type { MemoryDeps } from '../deps.js';
import type { MemoryItemKind, MemoryNodeType } from '@ema-agent/storage';

export const PROTECTED_MEMORY_NODE_TYPES = [
  'user_fact',
  'preference',
  'relationship',
] as const satisfies readonly MemoryNodeType[];

export const PROTECTED_MEMORY_ITEM_KINDS = [
  'user',
  'feedback',
] as const satisfies readonly MemoryItemKind[];

export interface MaintenanceOptions {
  /** 连续多少天未被引用后进入衰减候选。 */
  decayAfterDays:     number;
  /** 每轮从候选项的重要度中扣除的点数。 */
  decayAmount:        number;
  /** 是否同时处理 memory_items。 */
  decayItems:         boolean;
  /** 只生成预览，不写入数据库。 */
  dryRun:             boolean;
  /** 显式时钟让维护任务和测试使用同一截止时间。 */
  nowMs:              number;
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

/**
 * 保护类永不自动衰减；预览与实际写入使用同一批候选，避免用户确认后语义漂移。
 */
export function runMaintenance(
  deps: MemoryDeps,
  opts: MaintenanceOptions,
): MaintenanceReport {
  const t0 = Date.now();
  const cutoff = opts.nowMs - opts.decayAfterDays * 24 * 60 * 60 * 1000;

  const nodeCandidates = deps.nodes.listDecayCandidates(
    cutoff,
    PROTECTED_MEMORY_NODE_TYPES,
  );
  const itemCandidates = opts.decayItems
    ? deps.items.listDecayCandidates(
      cutoff,
      opts.nowMs,
      PROTECTED_MEMORY_ITEM_KINDS,
    )
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

/** 用户明确删除节点时，外键级联清理边和延迟更新。 */
export function deleteNode(deps: MemoryDeps, nodeId: string): void {
  deps.nodes.delete(nodeId);
}

/** 用户明确删除独立 Memory Item。 */
export function deleteItem(deps: MemoryDeps, itemId: string): void {
  deps.items.delete(itemId);
}
