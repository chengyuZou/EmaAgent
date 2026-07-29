import type { ExecutionProfile } from '@ema-agent/turn';
// 执行 Memory 提取的模型准备、跨库提交、恢复标记和全局索引更新流水线。
import type { SessionId } from '@ema-agent/ids';
import type {
  MemoryNodeType,
  MemoryNodeRow,
} from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type { MemorySettings } from '../types.js';
import type { ExtractionOutput, PendingFragment } from './types.js';
import { runExtraction } from './llm-call.js';
import { buildExtractionPrompt, renderFragmentsForPrompt } from './prompts.js';
import { readPending, clearPending } from './pending.js';
import { EmbedService } from '../embed/service.js';
import type { VectorIndex } from '../vector-index/vector-index.js';
import { processNodes, planNodeDuplicateJudgments } from './route-nodes.js';
import { processEdges } from './route-edges.js';
import { processItems } from './route-items.js';
import { NodeDirectory } from './node-directory.js';
import { appendSessionNote, compactSessionNoteIfNeeded } from './session-note.js';
import { consolidatePendingNodes } from './consolidate.js';
import {
  applyIndexMutations,
  type PendingIndexMutation,
} from './index-mutations.js';
import type { EmbeddedText } from '../types.js';
import type { MemoryExtractionRunRow } from '@ema-agent/storage';
import type { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';
import { MemoryLeaseLostError } from '../errors.js';

// ── Pipeline ─────────────────────────────────────────────────────────────────

export interface ExtractionPipelineDeps {
  memory:   MemoryDeps;
  embed:    EmbedService;
  settings: MemorySettings;
  nodesIndex: VectorIndex | null;
  itemsIndex: VectorIndex | null;
  indexSpaceId: string | null;
  commitCoordinator: MemoryCommitCoordinator;
}

export interface PipelineResult {
  extractedNodes: number;
  extractedEdges: number;
  extractedItems: number;
  lazyUpdatesQueued: number;
  consolidatedNodes: number;
  /** 落点不明确被丢弃的边数(B-076): 同名多 type 或端点不存在的边不落库。 */
  droppedEdges: number;
}

/**
 * Drain the pending fragments buffer, run the extraction LLM, route outputs
 * to nodes / edges / items, embed new rows, queue lazy updates against
 * existing nodes, and finally consolidate any nodes whose lazy buffer is
 * non-empty.
 *
 * 以 memory task id 作为 run id 保证重试幂等：profile.db 先在单事务内
 * 提交全局记忆和恢复标记，data.db 再原子提交 session note 与 pending 消费。
 * 两段之间失败时，重试读取恢复标记并只补完 data.db，不重复写全局记忆。
 */
export async function runExtractionPipeline(
  deps: ExtractionPipelineDeps,
  args: {
    sessionId:           SessionId;
    executionProfile:    ExecutionProfile;
    /** memory_tasks.id；同一任务重试时保持不变，用作跨数据库恢复键。 */
    runId:               string;
    signal?:             AbortSignal;
    /** Skip the LLM-driven consolidation pass — used when overrides.consolidation = false. */
    skipConsolidation?:  boolean;
    /**
     * 提交前的租约探针：返回 false 时立即抛 MemoryLeaseLostError 中止。
     * 缺省不检查（测试与直接调用方）；任务 Runner 始终传入。
     */
    isLeaseValid?:       () => boolean;
  },
): Promise<PipelineResult> {
  if (!args.runId.trim()) throw new Error('memory.extract: runId must not be empty');
  const assertLeaseValid = (): void => {
    if (args.isLeaseValid && !args.isLeaseValid()) throw new MemoryLeaseLostError();
  };

  const stats: PipelineResult = {
    extractedNodes:    0,
    extractedEdges:    0,
    extractedItems:    0,
    lazyUpdatesQueued: 0,
    consolidatedNodes: 0,
    droppedEdges:      0,
  };

  const fragments = readPending(deps.memory.pendingFragments, args.sessionId);
  const hasPending = fragments.length > 0;
  const recoveredRun = deps.memory.extractionRuns.findById(args.runId);

  if (!hasPending) {
    // data.db 已提交但进程尚未来得及删除 profile.db 标记时，重试负责收尾。
    if (recoveredRun) {
      validateRecoveryRun(recoveredRun, args.sessionId);
      await deps.commitCoordinator.runExclusive(() => {
        assertLeaseValid();
        deps.memory.extractionRuns.delete(args.runId);
      });
    }
    // Pending was already cleared by a prior run that failed AFTER clearPending.
    // Still check for unconsolidated lazy_updates and finish the work.
    if (!args.skipConsolidation) {
      const lazyIds = deps.memory.lazyUpdates.listNodesWithPending();
      if (lazyIds.length > 0) {
        // This can throw: the task runner will retry until consolidation succeeds.
        stats.consolidatedNodes = await deps.commitCoordinator.runExclusive(
          () => {
            assertLeaseValid();
            return consolidatePendingNodes(deps, args.signal, assertLeaseValid);
          },
        );
      }
    }
    return stats;
  }

  // Derive a per-extraction turnId from the first fragment so items can be
  // deduped by (session, title, turn) rather than (session, title) alone.
  const extractionTurnId = fragments[0]!.turnId;
  let noteDelta: string;

  if (recoveredRun) {
    validateRecoveryRun(recoveredRun, args.sessionId, extractionTurnId);
    restoreStats(stats, recoveredRun);
    noteDelta = recoveredRun.note_delta;
  } else {
    // ── 1. Build prompt + run LLM ───────────────────────────────────────────
    const existingNodes = deps.memory.nodes.listAll(500);
    const existingLabels = existingNodes.map(n => `${n.label} [${n.node_type}]`);
    const prompt = buildExtractionPrompt({
      executionProfile: args.executionProfile,
      fragments,
      existingNodeLabels: existingLabels,
    });

    const output = await runExtraction(
      deps.memory.llm,
      deps.memory.modelBindings,
      prompt,
      args.signal,
      renderFragmentsForPrompt(fragments),
    );
    if (!output) {
      // 未配置 memory model 时仍在 data.db 内原子清空，避免 buffer 永久堆积；
      // 但提取机会被丢弃必须显式可见，不能静默。
      deps.memory.emit?.({
        type: 'memory_extraction_skipped',
        sessionId: args.sessionId,
        reason: '未配置 memory 提取模型，本次对话片段已跳过提取',
      });
      await deps.commitCoordinator.runExclusive(() => {
        assertLeaseValid();
        deps.memory.runDataTransaction(() => {
          clearPending(deps.memory.pendingFragments, args.sessionId, Date.now());
        });
      });
      return stats;
    }

    // ── 2. 事务前完成全部外部 I/O 与结果验证 ───────────────────────────────
    const [nodeResult, itemResult] = await Promise.allSettled([
      output.new_nodes.length > 0
        ? deps.embed.embedMany(output.new_nodes.map(n => `${n.label}: ${n.description}`))
        : Promise.resolve(null),
      output.memory_items.length > 0
        ? deps.embed.embedMany(output.memory_items.map(i => `${i.title}: ${i.body}`))
        : Promise.resolve(null),
    ]);
    if (nodeResult.status === 'rejected') throw nodeResult.reason;
    if (itemResult.status === 'rejected') throw itemResult.reason;

    const nodeEmbeddings = nodeResult.value;
    const itemEmbeddings = itemResult.value;
    validatePreparedExtraction(output, nodeEmbeddings, itemEmbeddings);

    // LLM 判定属于外部 I/O，必须在事务前完成；事务内只执行已确定的判定。
    const duplicateJudgments = await planNodeDuplicateJudgments(
      deps,
      output,
      nodeEmbeddings,
    );

    noteDelta = output.session_note_delta;

    await deps.commitCoordinator.runExclusive(() => {
      // 闸门 ：LLM 与 embedding 是外部 I/O，等待期间租约可能已易主；
      // 恢复标记只在未被删除时有效，迟到提交必须在这里拦下。
      assertLeaseValid();
      // 等待 gate 期间其他 Session 可能已经创建节点，因此提交前重建目录。
      const directory = new NodeDirectory();
      for (const node of deps.memory.nodes.listAll(500)) {
        directory.register(node.label, node.node_type, node.id);
      }
      const indexMutations: PendingIndexMutation[] = [];

      // ── 3. profile.db：业务表与恢复标记一次提交 ───────────────────────────
      deps.memory.runProfileTransaction(() => {
        processNodes(
          deps,
          args.sessionId,
          output,
          fragments,
          stats,
          directory,
          nodeEmbeddings,
          indexMutations,
          duplicateJudgments,
        );
        processEdges(deps, output, stats, directory);
        processItems(
          deps,
          args.sessionId,
          args.executionProfile,
          output,
          stats,
          itemEmbeddings,
          extractionTurnId,
          indexMutations,
        );
        deps.memory.extractionRuns.insert({
          runId:            args.runId,
          sessionId:        args.sessionId,
          sourceTurnId:     extractionTurnId,
          noteDelta:        output.session_note_delta,
          nodesCount:       stats.extractedNodes,
          edgesCount:       stats.extractedEdges,
          itemsCount:       stats.extractedItems,
          lazyUpdatesCount: stats.lazyUpdatesQueued,
          committedAt:      Date.now(),
        });
      });

      // 索引是派生缓存：只能在 SQLite 成功提交后更新，且与下一次全局提交串行。
      applyIndexMutations(indexMutations);
    });
  }

  await deps.commitCoordinator.runExclusive(() => {
    // 闸门 ：profile 已提交、标记即将删除，此后租约再丢就再无防护。
    assertLeaseValid();
    // ── 4. data.db：note 与 pending 消费一次提交 ────────────────────────────
    deps.memory.runDataTransaction(() => {
      if (noteDelta.trim()) {
        appendSessionNote(deps, args.sessionId, noteDelta, extractionTurnId);
      }
      clearPending(deps.memory.pendingFragments, args.sessionId, Date.now());
    });

    // data.db 已持久化；删除恢复标记。若此处失败，重试在无 pending 分支清理。
    deps.memory.extractionRuns.delete(args.runId);
  });

  // ── 5. Compact L1 note if it has grown over budget ────────────────────────
  // 普通压缩失败不影响提取结果；租约丢失必须继续向上抛，不能被 best-effort 吞掉。
  try {
    await compactSessionNoteIfNeeded(
      deps,
      args.sessionId,
      args.executionProfile,
      args.signal,
      assertLeaseValid,
    );
  } catch (error) {
    if (error instanceof MemoryLeaseLostError) throw error;
    console.warn(
      '[memory] compactSessionNoteIfNeeded failed:',
      error instanceof Error ? error.message : error,
    );
  }

  // ── 6. Consolidate any nodes with lazy_updates ───────────────────────────
  // 不吞异常：失败后由 task runner 重试。data.db 已在 step 4 消费 pending，
  // 因此重试会进入上面的空 fragment 分支，只继续 consolidation，
  // 不会重新提取或重复追加 session note。
  if (!args.skipConsolidation) {
    const pendingNodeIds = deps.memory.lazyUpdates.listNodesWithPending();
    if (pendingNodeIds.length > 0) {
      deps.memory.emit?.({
        type:      'memory_consolidation_started',
        nodeCount: pendingNodeIds.length,
      });
      const t0 = Date.now();
      stats.consolidatedNodes = await deps.commitCoordinator.runExclusive(
        () => {
          assertLeaseValid();
          return consolidatePendingNodes(deps, args.signal, assertLeaseValid);
        },
      );
      deps.memory.emit?.({
        type:          'memory_consolidation_completed',
        consolidated:  stats.consolidatedNodes,
        durationMs:    Date.now() - t0,
      });
    }
  }

  return stats;
}

// Surface the type for orchestrators wanting to type the result
export type { MemoryNodeRow, MemoryNodeType };

function validatePreparedExtraction(
  output: ExtractionOutput,
  nodeEmbeddings: EmbeddedText[] | null,
  itemEmbeddings: EmbeddedText[] | null,
): void {
  if (nodeEmbeddings && nodeEmbeddings.length !== output.new_nodes.length) {
    throw new Error(
      `memory.extract: node embedding count mismatch (${nodeEmbeddings.length}/${output.new_nodes.length})`,
    );
  }
  if (itemEmbeddings && itemEmbeddings.length !== output.memory_items.length) {
    throw new Error(
      `memory.extract: item embedding count mismatch (${itemEmbeddings.length}/${output.memory_items.length})`,
    );
  }
}

function validateRecoveryRun(
  run: MemoryExtractionRunRow,
  sessionId: SessionId,
  sourceTurnId?: string,
): void {
  if (run.session_id !== sessionId) {
    throw new Error(
      `memory.extract: recovery run ${run.run_id} belongs to another session`,
    );
  }
  if (sourceTurnId !== undefined && run.source_turn_id !== sourceTurnId) {
    throw new Error(
      `memory.extract: recovery run ${run.run_id} source turn mismatch`,
    );
  }
}

function restoreStats(stats: PipelineResult, run: MemoryExtractionRunRow): void {
  stats.extractedNodes    = run.nodes_count;
  stats.extractedEdges    = run.edges_count;
  stats.extractedItems    = run.items_count;
  stats.lazyUpdatesQueued = run.lazy_updates_count;
}
