// 在全局 Memory 超过逻辑字节预算时，按可恢复程度分级释放载荷。

import type { MemoryStorageFootprint } from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';
import type { MemoryStorageSettings, MemoryMaintenanceSettings } from '../settings.js';
import {
  PROTECTED_MEMORY_ITEM_KINDS,
  PROTECTED_MEMORY_NODE_TYPES,
} from './decay.js';

const RECLAIM_RATIO = 0.85;
const STORAGE_BATCH_SIZE = 200;
const DAY_MS = 86_400_000;

export interface MemoryStorageBudgetReport {
  ran: boolean;
  beforeBytes: number;
  afterBytes: number;
  maxBytes: number;
  targetBytes: number;
  expiredItemsDeleted: number;
  coldNodesDeleted: number;
  coldItemsDeleted: number;
  nodeEmbeddingsEvicted: number;
  itemEmbeddingsEvicted: number;
  pressureRemaining: boolean;
}

export async function enforceMemoryStorageBudget(
  deps: MemoryDeps,
  settings: {
    storage: MemoryStorageSettings;
    maintenance: MemoryMaintenanceSettings;
  },
  opts: {
    commitCoordinator: MemoryCommitCoordinator;
    removeNodeFromIndex: (id: string) => void;
    removeItemFromIndex: (id: string) => void;
    refreshIndexes: () => Promise<void>;
    nowMs?: number;
    signal?: AbortSignal;
  },
): Promise<MemoryStorageBudgetReport> {
  opts.signal?.throwIfAborted();
  const before = deps.storage.logicalFootprint();
  const maxBytes = settings.storage.maxBytes;
  const targetBytes = Math.floor(maxBytes * RECLAIM_RATIO);
  if (before.totalBytes <= maxBytes) {
    return emptyReport(before, maxBytes, targetBytes);
  }

  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - settings.maintenance.coldDeleteAfterDays * DAY_MS;
  const report = emptyReport(before, maxBytes, targetBytes);
  report.ran = true;

  await opts.commitCoordinator.runExclusive(async () => {
    opts.signal?.throwIfAborted();
    let footprint = deps.storage.logicalFootprint();
    let indexSyncFailed = false;

    const removeFromIndexes = (
      nodeIds: readonly string[],
      itemIds: readonly string[],
    ): void => {
      try {
        for (const id of nodeIds) opts.removeNodeFromIndex(id);
        for (const id of itemIds) opts.removeItemFromIndex(id);
      } catch {
        indexSyncFailed = true;
      }
    };

    try {
      // Tier 0：显式过期数据已失效，先清理它们，不牺牲仍有效的 Memory。
      while (footprint.totalBytes > targetBytes) {
        opts.signal?.throwIfAborted();
        const ids = deps.storage.listExpiredItemIds(nowMs, STORAGE_BATCH_SIZE);
        if (ids.length === 0) break;
        const deleted = deps.runProfileTransaction(() => deps.storage.deleteItems(ids));
        report.expiredItemsDeleted += deleted;
        removeFromIndexes([], ids);
        footprint = deps.storage.logicalFootprint();
        await yieldToForegroundWork();
      }

      // Tier 1：只删除已经衰减到 0 且长期未引用的非保护类正文。
      while (footprint.totalBytes > targetBytes) {
        opts.signal?.throwIfAborted();
        const nodeIds = deps.storage.listColdZeroImportanceNodeIds(
          cutoff,
          PROTECTED_MEMORY_NODE_TYPES,
          STORAGE_BATCH_SIZE,
        );
        const itemIds = deps.storage.listColdZeroImportanceItemIds(
          cutoff,
          PROTECTED_MEMORY_ITEM_KINDS,
          STORAGE_BATCH_SIZE,
        );
        if (nodeIds.length === 0 && itemIds.length === 0) break;
        deps.runProfileTransaction(() => {
          report.coldNodesDeleted += deps.storage.deleteNodes(nodeIds);
          report.coldItemsDeleted += deps.storage.deleteItems(itemIds);
        });
        removeFromIndexes(nodeIds, itemIds);
        footprint = deps.storage.logicalFootprint();
        await yieldToForegroundWork();
      }

      // Tier 2：正文仍保留，只驱逐最冷的非保护类向量；显式标记防止修复任务反复重嵌。
      while (footprint.totalBytes > targetBytes) {
        opts.signal?.throwIfAborted();
        const nodeIds = deps.storage.listColdEmbeddedNodeIds(
          cutoff,
          PROTECTED_MEMORY_NODE_TYPES,
          STORAGE_BATCH_SIZE,
        );
        const itemIds = deps.storage.listColdEmbeddedItemIds(
          nowMs,
          cutoff,
          PROTECTED_MEMORY_ITEM_KINDS,
          STORAGE_BATCH_SIZE,
        );
        if (nodeIds.length === 0 && itemIds.length === 0) break;
        deps.runProfileTransaction(() => {
          report.nodeEmbeddingsEvicted += deps.storage.evictNodeEmbeddings(nodeIds, nowMs);
          report.itemEmbeddingsEvicted += deps.storage.evictItemEmbeddings(itemIds, nowMs);
        });
        removeFromIndexes(nodeIds, itemIds);
        footprint = deps.storage.logicalFootprint();
        await yieldToForegroundWork();
      }

      opts.signal?.throwIfAborted();
      report.afterBytes = footprint.totalBytes;
      report.pressureRemaining = footprint.totalBytes > maxBytes;
    } finally {
      if (indexSyncFailed) await opts.refreshIndexes();
    }
  });

  opts.signal?.throwIfAborted();
  deps.emit?.({
    type: 'memory_storage_budget_enforced',
    beforeBytes: report.beforeBytes,
    afterBytes: report.afterBytes,
    maxBytes: report.maxBytes,
    deletedRows:
      report.expiredItemsDeleted
      + report.coldNodesDeleted
      + report.coldItemsDeleted,
    evictedEmbeddings:
      report.nodeEmbeddingsEvicted
      + report.itemEmbeddingsEvicted,
    pressureRemaining: report.pressureRemaining,
  });
  return report;
}

/** 每个有界批次后让出事件循环，让新 Turn 能及时触发维护取消。 */
function yieldToForegroundWork(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function emptyReport(
  footprint: MemoryStorageFootprint,
  maxBytes: number,
  targetBytes: number,
): MemoryStorageBudgetReport {
  return {
    ran: false,
    beforeBytes: footprint.totalBytes,
    afterBytes: footprint.totalBytes,
    maxBytes,
    targetBytes,
    expiredItemsDeleted: 0,
    coldNodesDeleted: 0,
    coldItemsDeleted: 0,
    nodeEmbeddingsEvicted: 0,
    itemEmbeddingsEvicted: 0,
    pressureRemaining: false,
  };
}
