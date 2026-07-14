import type { SessionId, TurnMode } from '@ema-agent/contracts';
import type {
  MemoryNodeType,
  MemoryNodeRow,
} from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type { MemorySettings } from '../types.js';
import type { ExtractionOutput, PendingFragment } from './types.js';
import { runExtraction } from './llm-call.js';
import { bestEffortAsync } from '../best-effort.js';
import { buildExtractionPrompt } from './prompts.js';
import { readPending, clearPending } from './pending.js';
import { EmbedService } from '../embed/service.js';
import type { VectorIndex } from '../vector-index/vector-index.js';
import { processNodes } from './route-nodes.js';
import { processEdges } from './route-edges.js';
import { processItems } from './route-items.js';
import { appendSessionNote, compactSessionNoteIfNeeded } from './session-note.js';
import { consolidatePendingNodes } from './consolidate.js';

// ── Pipeline ─────────────────────────────────────────────────────────────────

export interface ExtractionPipelineDeps {
  memory:   MemoryDeps;
  embed:    EmbedService;
  settings: MemorySettings;
  nodesIndex: VectorIndex | null;
  itemsIndex: VectorIndex | null;
  indexSpaceId: string | null;
}

export interface PipelineResult {
  extractedNodes: number;
  extractedEdges: number;
  extractedItems: number;
  lazyUpdatesQueued: number;
  consolidatedNodes: number;
}

/**
 * Drain the pending fragments buffer, run the extraction LLM, route outputs
 * to nodes / edges / items, embed new rows, queue lazy updates against
 * existing nodes, and finally consolidate any nodes whose lazy buffer is
 * non-empty.
 *
 * Idempotent at the buffer level: if extraction fails halfway, the buffer
 * is *not* cleared and the task will retry. Once we hit the "clear buffer"
 * step, everything else is best-effort — failures don't poison the queue.
 */
export async function runExtractionPipeline(
  deps: ExtractionPipelineDeps,
  args: {
    sessionId:           SessionId;
    mode:                TurnMode;
    signal?:             AbortSignal;
    /** Skip the LLM-driven consolidation pass — used when overrides.consolidation = false. */
    skipConsolidation?:  boolean;
  },
): Promise<PipelineResult> {
  const stats: PipelineResult = {
    extractedNodes:    0,
    extractedEdges:    0,
    extractedItems:    0,
    lazyUpdatesQueued: 0,
    consolidatedNodes: 0,
  };

  const fragments = readPending(deps.memory.pendingFragments, args.sessionId);
  const hasPending = fragments.length > 0;

  if (!hasPending) {
    // Pending was already cleared by a prior run that failed AFTER clearPending.
    // Still check for unconsolidated lazy_updates and finish the work.
    if (!args.skipConsolidation) {
      const lazyIds = deps.memory.lazyUpdates.listNodesWithPending();
      if (lazyIds.length > 0) {
        // This can throw: the task runner will retry until consolidation succeeds.
        stats.consolidatedNodes = await consolidatePendingNodes(deps, args.signal);
      }
    }
    return stats;
  }

  // ── 1. Build prompt + run LLM ─────────────────────────────────────────────
  const existingNodes = deps.memory.nodes.listAll(500);
  const existingLabels = existingNodes.map(n => `${n.label} [${n.node_type}]`);

  const prompt = buildExtractionPrompt({
    mode: args.mode,
    fragments,
    existingNodeLabels: existingLabels,
  });

  const output = await runExtraction(
    deps.memory.llm,
    deps.memory.modelBindings,
    prompt,
    args.signal,
  );
  if (!output) {
    // No memory model configured — clear buffer to avoid permanent build-up.
    clearPending(deps.memory.pendingFragments, args.sessionId, Date.now());
    return stats;
  }

  // ── 2. Pre-batch ALL external I/O (embed) ────────────────────────────────
  // All async/fallible calls happen here, BEFORE any DB write.
  // If embedding times out, no DB state has changed → safe to retry from scratch.
  const [nodeResult, itemResult] = await Promise.allSettled([
    output.new_nodes.length > 0
      ? deps.embed.embedMany(output.new_nodes.map(n => `${n.label}: ${n.description}`))
      : Promise.resolve(null),
    output.memory_items.length > 0
      ? deps.embed.embedMany(output.memory_items.map(i => `${i.title}: ${i.body}`))
      : Promise.resolve(null),
  ]);

  // 任一失败就整体抛出，不做部分写入
  if (nodeResult.status === 'rejected') throw nodeResult.reason;
  if (itemResult.status === 'rejected') throw itemResult.reason;

  const nodeEmbeddings = nodeResult.value;
  const itemEmbeddings = itemResult.value;

  // Derive a per-extraction turnId from the first fragment so items can be
  // deduped by (session, title, turn) rather than (session, title) alone.
  const extractionTurnId = fragments[0]?.turnId;

  // ── 3. Route outputs (pure DB writes, no async) ───────────────────────────

  // Track labels of nodes that exist (existing + newly created) so edges can
  // resolve their endpoints. Keyed by label string.
  const labelToNodeId = new Map<string, string>();
  for (const n of existingNodes) labelToNodeId.set(n.label, n.id);

  // Process new_nodes — dedup, route to either lazy_updates or insert
  processNodes(deps, args.sessionId, output, fragments, stats, labelToNodeId, nodeEmbeddings);

  // Process new_edges using the now-fresh labelToNodeId map
  processEdges(deps, output, stats, labelToNodeId);

  // Process memory_items — upsert with turn-scoped idempotency
  processItems(deps, args.sessionId, args.mode, output, stats, itemEmbeddings, extractionTurnId);

  // Process session_note_delta — append to session_notes.body
  if (output.session_note_delta.trim()) {
    appendSessionNote(deps, args.sessionId, output.session_note_delta, extractionTurnId!);
  }

  // ── 3. Clear pending fragments ───────────────────────────────────────────
  // Moved BEFORE consolidation: if consolidation fails, pending is already
  // cleared so a retry won't re-append the same session_note_delta or
  // re-insert duplicate nodes/items. Consolidation failure is non-fatal —
  // lazy_updates stay buffered and drain on the next extraction run.
  clearPending(deps.memory.pendingFragments, args.sessionId, Date.now());

  // ── 4. Compact L1 note if it has grown over budget ────────────────────────
  // Non-fatal — note stays verbose, next run may compact. Logged for visibility.
  await bestEffortAsync('compactSessionNoteIfNeeded',
    () => compactSessionNoteIfNeeded(deps, args.sessionId, args.mode, args.signal), undefined);

  // ── 5. Consolidate any nodes with lazy_updates ───────────────────────────
  // NOT wrapped in try/catch: if this throws, the task runner marks the task
  // failed and retries. Because clearPending already ran (step 3), the retry
  // sees empty fragments, falls into the early-return path above, and runs
  // ONLY consolidation — no duplicate extraction, no double session_note append.
  if (!args.skipConsolidation) {
    const pendingNodeIds = deps.memory.lazyUpdates.listNodesWithPending();
    if (pendingNodeIds.length > 0) {
      deps.memory.emit?.({
        type:      'memory_consolidation_started',
        nodeCount: pendingNodeIds.length,
      });
      const t0 = Date.now();
      stats.consolidatedNodes = await consolidatePendingNodes(deps, args.signal);
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
