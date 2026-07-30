// 分批衰减长期未引用的 Memory，并用持久周期与统一提交锁避免重复扣减和并发覆盖。

import type {
  MemoryItemKind,
  MemoryNodeType,
} from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DECAY_BATCH_SIZE = 200;
const MAX_PREVIEW_ROWS = 5_000;

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
  /** 连续多少天未被引用后进入衰减候选，也是同一行两次衰减的最短周期。 */
  decayAfterDays: number;
  /** 每轮从候选项的重要度中扣除的点数。 */
  decayAmount: number;
  /** 是否同时处理 memory_items。 */
  decayItems: boolean;
  /** 只生成预览，不写入数据库。 */
  dryRun: boolean;
  /** 显式时钟让维护任务和测试使用同一截止时间。 */
  nowMs: number;
}

export interface MaintenancePreview {
  nodes: Array<{
    id: string;
    label: string;
    nodeType: MemoryNodeType;
    currentImportance: number;
    newImportance: number;
  }>;
  items: Array<{
    id: string;
    title: string;
    currentImportance: number;
    newImportance: number;
  }>;
  decayedAt: number;
}

export interface MaintenanceReport {
  dryRun: boolean;
  decayedNodes: number;
  decayedItems: number;
  preview: MaintenancePreview;
}

interface DecayBatch {
  nodes: MaintenancePreview['nodes'];
  items: MaintenancePreview['items'];
}

/**
 * 候选读取与 CAS 更新放在同一个同步事务中；协调器只包住短 SQL，
 * 不包模型、向量或其他异步工作。
 */
export async function runMaintenance(
  deps: MemoryDeps,
  opts: MaintenanceOptions,
  commitCoordinator: MemoryCommitCoordinator,
  signal?: AbortSignal,
): Promise<MaintenanceReport> {
  const startedAt = Date.now();
  const cutoff = opts.nowMs - opts.decayAfterDays * DAY_MS;
  const cycleCutoff = cutoff;

  if (opts.dryRun) {
    signal?.throwIfAborted();
    const batch = readPreview(
      deps,
      opts,
      cutoff,
      cycleCutoff,
      MAX_PREVIEW_ROWS,
    );
    const report = buildReport(opts, batch, 0, 0);
    emitCompleted(deps, report, startedAt);
    return report;
  }

  const preview: DecayBatch = { nodes: [], items: [] };
  let decayedNodes = 0;
  let decayedItems = 0;

  while (true) {
    signal?.throwIfAborted();
    const committed = await commitCoordinator.runExclusive(() => {
      signal?.throwIfAborted();
      return deps.runProfileTransaction(() => {
        const candidates = readCandidates(
          deps,
          opts,
          cutoff,
          cycleCutoff,
          DECAY_BATCH_SIZE,
        );
        const nodeIds = new Set(deps.nodes.applyDecayUpdates(
          candidates.nodeRows.map(row => ({
            id: row.id,
            importance: Math.max(0, row.importance - opts.decayAmount),
            expectedImportance: row.importance,
            expectedLastReferencedAt: row.last_referenced_at,
            expectedLastDecayedAt: row.last_decayed_at,
            updatedAt: opts.nowMs,
          })),
        ));
        const itemIds = new Set(deps.items.applyDecayUpdates(
          candidates.itemRows.map(row => ({
            id: row.id,
            importance: Math.max(0, row.importance - opts.decayAmount),
            expectedImportance: row.importance,
            expectedLastReferencedAt: row.last_referenced_at,
            expectedLastDecayedAt: row.last_decayed_at,
            updatedAt: opts.nowMs,
          })),
        ));
        return {
          nodes: candidates.preview.nodes.filter(row => nodeIds.has(row.id)),
          items: candidates.preview.items.filter(row => itemIds.has(row.id)),
        };
      });
    });

    decayedNodes += committed.nodes.length;
    decayedItems += committed.items.length;
    appendPreview(preview, committed);

    if (committed.nodes.length === 0 && committed.items.length === 0) break;
    signal?.throwIfAborted();
    await yieldToEventLoop();
  }

  const report = buildReport(opts, preview, decayedNodes, decayedItems);
  if (decayedNodes > 0 || decayedItems > 0) {
    emitCompleted(deps, report, startedAt);
  }
  return report;
}

function readPreview(
  deps: MemoryDeps,
  opts: MaintenanceOptions,
  cutoff: number,
  cycleCutoff: number,
  limit: number,
): DecayBatch {
  const preview = readCandidates(
    deps,
    opts,
    cutoff,
    cycleCutoff,
    limit,
  ).preview;
  const nodes = preview.nodes.slice(0, MAX_PREVIEW_ROWS);
  return {
    nodes,
    items: preview.items.slice(0, MAX_PREVIEW_ROWS - nodes.length),
  };
}

function readCandidates(
  deps: MemoryDeps,
  opts: MaintenanceOptions,
  cutoff: number,
  cycleCutoff: number,
  limit: number,
) {
  const nodeRows = deps.nodes.listDecayCandidates(
    cutoff,
    cycleCutoff,
    PROTECTED_MEMORY_NODE_TYPES,
    limit,
  );
  const itemRows = opts.decayItems
    ? deps.items.listDecayCandidates(
      cutoff,
      cycleCutoff,
      opts.nowMs,
      PROTECTED_MEMORY_ITEM_KINDS,
      limit,
    )
    : [];
  return {
    nodeRows,
    itemRows,
    preview: {
      nodes: nodeRows.map(row => ({
        id: row.id,
        label: row.label,
        nodeType: row.node_type,
        currentImportance: row.importance,
        newImportance: Math.max(0, row.importance - opts.decayAmount),
      })),
      items: itemRows.map(row => ({
        id: row.id,
        title: row.title,
        currentImportance: row.importance,
        newImportance: Math.max(0, row.importance - opts.decayAmount),
      })),
    },
  };
}

function buildReport(
  opts: MaintenanceOptions,
  preview: DecayBatch,
  decayedNodes: number,
  decayedItems: number,
): MaintenanceReport {
  return {
    dryRun: opts.dryRun,
    decayedNodes,
    decayedItems,
    preview: {
      ...preview,
      decayedAt: opts.nowMs,
    },
  };
}

function appendPreview(target: DecayBatch, rows: DecayBatch): void {
  let remaining = MAX_PREVIEW_ROWS - target.nodes.length - target.items.length;
  if (remaining <= 0) return;
  const nodes = rows.nodes.slice(0, remaining);
  target.nodes.push(...nodes);
  remaining -= nodes.length;
  if (remaining > 0) target.items.push(...rows.items.slice(0, remaining));
}

function emitCompleted(
  deps: MemoryDeps,
  report: MaintenanceReport,
  startedAt: number,
): void {
  deps.emit?.({
    type: 'memory_maintenance_completed',
    decayedNodes: report.decayedNodes,
    decayedItems: report.decayedItems,
    dryRun: report.dryRun,
    durationMs: Date.now() - startedAt,
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
