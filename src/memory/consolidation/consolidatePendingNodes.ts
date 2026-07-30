// 将节点待处理证据按快照计算，并以单节点 CAS 事务提交正文、向量和精确消费结果。

import type { MemoryNodeLazyUpdateRow, MemoryNodeRow } from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type { EmbedService } from '../embed/service.js';
import { unpackEmbedding } from '../embed/similarity.js';
import type { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';
import type { EmbeddedText } from '../types.js';
import type { VectorIndex } from '../vector-index/vector-index.js';
import { runConsolidationModel } from './modelCall.js';
import { buildConsolidationPrompt } from './prompt.js';

const DEFAULT_MAX_NODES = 500;

export interface ConsolidationDeps {
  memory: MemoryDeps;
  embed: EmbedService;
  nodesIndex: VectorIndex | null;
  indexSpaceId: string | null;
  commitCoordinator: MemoryCommitCoordinator;
  refreshIndexes: () => Promise<void>;
}

export interface ConsolidationOptions {
  maxNodes?: number;
  signal?: AbortSignal;
  /** Extraction 租约在模型往返期间可能易主，提交边界必须重新确认所有权。 */
  assertWritable?: () => void;
}

export interface ConsolidationReport {
  pendingNodes: number;
  consolidated: number;
  conflicts: number;
  orphanUpdatesDeleted: number;
}

interface NodeSnapshot {
  node: MemoryNodeRow;
  updates: MemoryNodeLazyUpdateRow[];
}

export async function consolidatePendingNodes(
  deps: ConsolidationDeps,
  options: ConsolidationOptions = {},
): Promise<ConsolidationReport> {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0 || maxNodes > 5000) {
    throw new RangeError('memory.consolidation: maxNodes must be between 1 and 5000');
  }

  options.signal?.throwIfAborted();
  options.assertWritable?.();
  const nodeIds = deps.memory.lazyUpdates.listNodesWithPending(maxNodes);
  const report: ConsolidationReport = {
    pendingNodes: nodeIds.length,
    consolidated: 0,
    conflicts: 0,
    orphanUpdatesDeleted: 0,
  };
  if (nodeIds.length === 0) return report;

  deps.memory.emit?.({
    type: 'memory_consolidation_started',
    nodeCount: nodeIds.length,
  });
  const startedAt = Date.now();

  for (const nodeId of nodeIds) {
    options.signal?.throwIfAborted();
    options.assertWritable?.();
    const snapshot = readSnapshot(deps.memory, nodeId);
    if (!snapshot) {
      report.orphanUpdatesDeleted += await deleteOrphanUpdates(
        deps,
        nodeId,
        options,
      );
      continue;
    }

    const modelResult = await runConsolidationModel(
      deps.memory.llm,
      deps.memory.modelBindings,
      buildConsolidationPrompt({
        label: snapshot.node.label,
        nodeType: snapshot.node.node_type,
        currentDescription: snapshot.node.description,
        fragments: snapshot.updates.map(update => update.fragment),
      }),
      options.signal,
    );
    if (!modelResult) continue;

    const embedded = await deps.embed.embedOne(
      `${snapshot.node.label}: ${modelResult.description}`,
      options.signal,
    );
    options.signal?.throwIfAborted();
    options.assertWritable?.();

    const committed = await commitSnapshot(
      deps,
      snapshot,
      modelResult,
      embedded,
      options,
    );
    if (committed) report.consolidated++;
    else report.conflicts++;
  }

  deps.memory.emit?.({
    type: 'memory_consolidation_completed',
    consolidated: report.consolidated,
    durationMs: Date.now() - startedAt,
  });
  return report;
}

function readSnapshot(memory: MemoryDeps, nodeId: string): NodeSnapshot | null {
  const node = memory.nodes.findById(nodeId);
  const updates = memory.lazyUpdates.listByNode(nodeId);
  if (!node || updates.length === 0) return null;
  return { node, updates };
}

async function deleteOrphanUpdates(
  deps: ConsolidationDeps,
  nodeId: string,
  options: ConsolidationOptions,
): Promise<number> {
  return deps.commitCoordinator.runExclusive(() => {
    options.signal?.throwIfAborted();
    options.assertWritable?.();
    return deps.memory.runProfileTransaction(() => {
      // 节点可能在等待协调器期间被重新创建；只有仍不存在时才清理孤儿。
      if (deps.memory.nodes.findById(nodeId)) return 0;
      const updates = deps.memory.lazyUpdates.listByNode(nodeId);
      return deps.memory.lazyUpdates.deleteByIds(updates.map(update => update.id));
    });
  });
}

async function commitSnapshot(
  deps: ConsolidationDeps,
  snapshot: NodeSnapshot,
  modelResult: { description: string; importanceDelta: number },
  embedded: EmbeddedText | null,
  options: ConsolidationOptions,
): Promise<boolean> {
  return deps.commitCoordinator.runExclusive(async () => {
    options.signal?.throwIfAborted();
    options.assertWritable?.();
    const updateIds = snapshot.updates.map(update => update.id);
    const committed = deps.memory.runProfileTransaction(() => {
      // 另一轮可能已经消费部分证据；不能用不完整快照更新节点。
      if (deps.memory.lazyUpdates.countByIds(updateIds) !== updateIds.length) {
        return false;
      }
      const updated = deps.memory.nodes.consolidateIfUnchanged({
        id: snapshot.node.id,
        description: modelResult.description,
        importanceDelta: modelResult.importanceDelta,
        embedding: embedded?.embedding ?? null,
        embeddingProviderId: embedded?.providerId ?? null,
        embeddingModel: embedded?.model ?? null,
        embeddingDim: embedded?.dim ?? null,
        embeddingNormalization: embedded?.space.normalization ?? null,
        embeddingRevision: embedded?.space.revision ?? null,
        embeddingSpaceId: embedded?.space.id ?? null,
        updatedAt: Date.now(),
        expectedDescription: snapshot.node.description,
        expectedImportance: snapshot.node.importance,
        expectedUpdatedAt: snapshot.node.updated_at,
      });
      if (!updated) return false;

      const deleted = deps.memory.lazyUpdates.deleteByIds(updateIds);
      if (deleted !== updateIds.length) {
        throw new Error(
          `memory.consolidation: consumed ${deleted}/${updateIds.length} lazy updates`,
        );
      }
      return true;
    });
    if (!committed) return false;

    try {
      syncIndex(deps, snapshot.node.id, embedded);
    } catch {
      // SQLite 已提交后不能回滚事实源；在同一协调序列里重建，避免并发写穿过重建窗口。
      await deps.refreshIndexes();
    }
    return true;
  });
}

function syncIndex(
  deps: ConsolidationDeps,
  nodeId: string,
  embedded: EmbeddedText | null,
): void {
  if (
    embedded
    && deps.nodesIndex
    && deps.indexSpaceId === embedded.space.id
    && deps.nodesIndex.dim === embedded.dim
  ) {
    deps.nodesIndex.update(
      nodeId,
      unpackEmbedding(embedded.embedding, embedded.dim),
    );
    return;
  }
  deps.nodesIndex?.remove(nodeId);
}
