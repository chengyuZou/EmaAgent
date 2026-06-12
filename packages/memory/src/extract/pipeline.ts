import crypto from 'node:crypto';
import type { SessionId, TurnMode } from '@ema-agent/contracts';
import type {
  MemoryNodeType,
  MemoryNodeRow,
} from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type { MemorySettings, EmbeddedText } from '../types.js';
import type {
  ExtractionOutput, ExtractedNode, PendingFragment, SessionNoteEntry,
} from './types.js';
import { safeParseEntries } from './types.js';
import { runExtraction, runConsolidation } from './llm-call.js';
import {
  buildExtractionPrompt, buildConsolidationPrompt,
} from './prompts.js';
import { buildNoteCompactionPrompt } from '../compact/prompts.js';
import { readPending, clearPending } from './pending.js';
import { EmbedService } from '../embed/service.js';
import { unpackEmbedding } from '../embed/similarity.js';
import { estimateTextTokens } from '@ema-agent/token';
import type { VectorIndex } from '../index/vector-index.js';

// ── Configuration knobs (mode-dependent) ─────────────────────────────────────

const NODE_DEDUP_THRESHOLD = 0.85; // cosine sim above this → treat as duplicate

// ── Pipeline ─────────────────────────────────────────────────────────────────

export interface ExtractionPipelineDeps {
  memory:   MemoryDeps;
  embed:    EmbedService;
  settings: MemorySettings;
  nodesIndex: VectorIndex | null;
  itemsIndex: VectorIndex | null;
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
  try {
    await compactSessionNoteIfNeeded(deps, args.sessionId, args.mode, args.signal);
  } catch { /* non-fatal — note stays verbose, next run may compact */ }

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

// ── Node processing (dedup via embedding + lazy_updates) ─────────────────────

function processNodes(
  deps: ExtractionPipelineDeps,
  sessionId: SessionId,
  output: ExtractionOutput,
  fragments: PendingFragment[],
  stats: PipelineResult,
  labelToNodeId: Map<string, string>,
  precomputedEmbeddings: EmbeddedText[] | null,
): void {
  for (let i = 0; i < output.new_nodes.length; i++) {
    const candidate = output.new_nodes[i]!;
    const embedded  = precomputedEmbeddings?.[i] ?? null;
    routeCandidateNode(deps, sessionId, candidate, embedded, fragments, stats, labelToNodeId);
  }
}

function routeCandidateNode(
  deps: ExtractionPipelineDeps,
  sessionId: SessionId,
  candidate: ExtractedNode,
  embedded: EmbeddedText | null,
  fragments: PendingFragment[],
  stats: PipelineResult,
  labelToNodeId: Map<string, string>,
): void {
  // 1. Cheap label match first
  const labelHit = deps.memory.nodes.findByLabelAndType(candidate.label, candidate.nodeType);
  if (labelHit) {
    enqueueLazyUpdate(deps, labelHit.id, candidate, fragments, sessionId, stats);
    labelToNodeId.set(candidate.label, labelHit.id);
    return;
  }

  // 2. Embedding-based dedup against the index (current provider only)
  if (embedded && deps.nodesIndex && deps.nodesIndex.dim === embedded.dim) {
    const view = unpackEmbedding(embedded.embedding, embedded.dim);
    const hits = deps.nodesIndex.search(view, 3);
    const best = hits[0];
    if (best && best.score >= NODE_DEDUP_THRESHOLD) {
      const existing = deps.memory.nodes.findById(best.id);
      if (existing && existing.node_type === candidate.nodeType) {
        enqueueLazyUpdate(deps, existing.id, candidate, fragments, sessionId, stats);
        labelToNodeId.set(candidate.label, existing.id);
        return;
      }
    }
  }

  // 3. Insert as new node — handle concurrent session race on UNIQUE(label, node_type)
  const id  = crypto.randomUUID();
  const now = Date.now();
  try {
    deps.memory.nodes.insert({
      id,
      label:       candidate.label,
      nodeType:    candidate.nodeType,
      description: candidate.description,
      embedding:           embedded?.embedding,
      embeddingProviderId: embedded?.providerId,
      embeddingModel:      embedded?.model,
      embeddingDim:        embedded?.dim,
      importance:  candidate.importance,
      createdAt:   now,
    });
    // Update in-memory vector index too
    if (embedded && deps.nodesIndex && deps.nodesIndex.dim === embedded.dim) {
      const view = unpackEmbedding(embedded.embedding, embedded.dim);
      deps.nodesIndex.add(id, view);
    }
    labelToNodeId.set(candidate.label, id);
    stats.extractedNodes++;
  } catch (err) {
    // Another session concurrently inserted the same (label, node_type).
    // Re-route to lazy_update against the winner instead of crashing.
    const isUnique = err instanceof Error &&
      (err.message.includes('UNIQUE') || err.message.includes('SQLITE_CONSTRAINT'));
    if (!isUnique) throw err;
    const existing = deps.memory.nodes.findByLabelAndType(candidate.label, candidate.nodeType);
    if (existing) {
      enqueueLazyUpdate(deps, existing.id, candidate, fragments, sessionId, stats);
      labelToNodeId.set(candidate.label, existing.id);
    }
  }
}

function enqueueLazyUpdate(
  deps: ExtractionPipelineDeps,
  nodeId: string,
  candidate: ExtractedNode,
  fragments: PendingFragment[],
  sessionId: SessionId,
  stats: PipelineResult,
): void {
  // Use the first fragment from this batch as the lineage source — good
  // enough for diagnostics; not security-critical.
  const source = fragments[0];
  const fragmentText = `${candidate.description} (imp:${candidate.importance})`;
  deps.memory.lazyUpdates.append({
    id:               crypto.randomUUID(),
    nodeId,
    fragment:         fragmentText,
    sourceSessionId:  sessionId,
    sourceTurnId:     source?.turnId,
    createdAt:        Date.now(),
  });
  stats.lazyUpdatesQueued++;
}

// ── Edge processing ─────────────────────────────────────────────────────────

function processEdges(
  deps: ExtractionPipelineDeps,
  output: ExtractionOutput,
  stats: PipelineResult,
  labelToNodeId: Map<string, string>,
): void {
  for (const edge of output.new_edges) {
    const fromId = labelToNodeId.get(edge.fromLabel);
    const toId   = labelToNodeId.get(edge.toLabel);
    if (!fromId || !toId) continue;
    if (fromId === toId)  continue;
    deps.memory.edges.upsert({
      id:         crypto.randomUUID(),
      fromNodeId: fromId,
      toNodeId:   toId,
      relation:   edge.relation,
      at:         Date.now(),
    });
    stats.extractedEdges++;
  }
}

// ── Item processing ─────────────────────────────────────────────────────────

function processItems(
  deps: ExtractionPipelineDeps,
  sessionId: SessionId,
  mode: TurnMode,
  output: ExtractionOutput,
  stats: PipelineResult,
  precomputedEmbeddings: EmbeddedText[] | null,
  extractionTurnId: string | undefined,
): void {
  if (output.memory_items.length === 0) return;

  const modes = inferModesForMode(mode);
  for (let i = 0; i < output.memory_items.length; i++) {
    const item = output.memory_items[i]!;
    const e    = precomputedEmbeddings?.[i] ?? null;
    const now  = Date.now();

    const existing = deps.memory.items.findBySourceAndTitle(sessionId, item.title);

    if (existing) {
      // Same session + same title: distinguish retry from legitimate update.
      //   - Same turnId → retry of the same extraction → skip entirely.
      //   - Different turnId → knowledge evolved in a new turn → update body.
      if (existing.source_turn_id === (extractionTurnId ?? null)) continue;

      deps.memory.items.updateBody({
        id:                  existing.id,
        body:                item.body,
        importance:          item.importance,
        sourceTurnId:        extractionTurnId,
        updatedAt:           now,
        embedding:           e?.embedding,
        embeddingProviderId: e?.providerId,
        embeddingModel:      e?.model,
        embeddingDim:        e?.dim,
      });
      if (e && deps.itemsIndex && deps.itemsIndex.dim === e.dim) {
        const view = unpackEmbedding(e.embedding, e.dim);
        deps.itemsIndex.update(existing.id, view);
      }
      // Count as extracted so the telemetry reflects the update
      stats.extractedItems++;
      continue;
    }

    // New item — insert fresh
    const id = crypto.randomUUID();
    deps.memory.items.insert({
      id,
      kind:                item.kind,
      title:               item.title,
      body:                item.body,
      modes,
      embedding:           e?.embedding,
      embeddingProviderId: e?.providerId,
      embeddingModel:      e?.model,
      embeddingDim:        e?.dim,
      sourceSessionId:     sessionId,
      sourceTurnId:        extractionTurnId as never,
      importance:          item.importance,
      createdAt:           now,
    });

    if (e && deps.itemsIndex && deps.itemsIndex.dim === e.dim) {
      const view = unpackEmbedding(e.embedding, e.dim);
      deps.itemsIndex.add(id, view);
    }
    stats.extractedItems++;
  }
}

function inferModesForMode(mode: TurnMode): string[] {
  // Tag the item with the current mode plus any cross-cutting modes.
  // chat / agent items are surfaced cross-mode; narrative items are only
  // useful in narrative (rare — narrative extraction usually doesn't write
  // memory_items at all, it focuses on Layer 0).
  if (mode === 'narrative') return ['narrative'];
  if (mode === 'agent')     return ['agent', 'chat'];
  return ['chat', 'agent'];
}

// ── Session note append ──────────────────────────────────────────────────────

function appendSessionNote(
  deps: ExtractionPipelineDeps,
  sessionId: SessionId,
  delta: string,
  turnId: string,
): void {
  const existing = deps.memory.sessionNotes.findBySession(sessionId);
  const now = Date.now();

  const entries: SessionNoteEntry[] = existing?.body
    ? safeParseEntries(existing.body)
    : [];
  entries.push({ at: now, turnId, delta: delta.trim() });
  const body = JSON.stringify(entries);
  deps.memory.sessionNotes.upsert({
    sessionId,
    body,
    tokensAtLastUpdate: estimateTextTokens(entries.map(e => e.delta).join('\n')),
    updatedAt:          now,
  });
}

// ── Consolidation of lazy_updates ───────────────────────────────────────────

async function consolidatePendingNodes(
  deps: ExtractionPipelineDeps,
  signal?: AbortSignal,
): Promise<number> {
  const nodeIds = deps.memory.lazyUpdates.listNodesWithPending();
  let consolidated = 0;

  for (const nodeId of nodeIds) {
    const node = deps.memory.nodes.findById(nodeId);
    if (!node) {
      // Node deleted between extraction and consolidation — drop the orphans
      const stale = deps.memory.lazyUpdates.listByNode(nodeId);
      deps.memory.lazyUpdates.deleteByIds(stale.map(s => s.id));
      continue;
    }

    const updates = deps.memory.lazyUpdates.listByNode(nodeId);
    if (updates.length === 0) continue;

    const prompt = buildConsolidationPrompt({
      label:              node.label,
      nodeType:           node.node_type,
      currentDescription: node.description,
      fragments:          updates.map(u => u.fragment),
    });

    const result = await runConsolidation(
      deps.memory.llm,
      deps.memory.modelBindings,
      prompt,
      signal,
    );
    if (!result) continue;

    // Re-embed the consolidated description so future similarity queries hit
    // the latest content.
    const reEmbed = await deps.embed.embedOne(
      `${node.label}: ${result.updated_description}`,
    );
    const now = Date.now();
    deps.memory.nodes.updateDescription({
      id:               node.id,
      description:      result.updated_description,
      importanceDelta:  result.importance_delta,
      updatedAt:        now,
    });
    if (reEmbed) {
      deps.memory.nodes.updateEmbedding({
        id:                  node.id,
        embedding:           reEmbed.embedding,
        embeddingProviderId: reEmbed.providerId,
        embeddingModel:      reEmbed.model,
        embeddingDim:        reEmbed.dim,
        updatedAt:           now,
      });
      if (deps.nodesIndex && deps.nodesIndex.dim === reEmbed.dim) {
        const view = unpackEmbedding(reEmbed.embedding, reEmbed.dim);
        deps.nodesIndex.update(node.id, view);
      }
    }

    // Drain only the rows we actually consolidated — new arrivals stay
    deps.memory.lazyUpdates.deleteByIds(updates.map(u => u.id));
    consolidated++;
  }

  return consolidated;
}

// ── L1 session note self-compaction ─────────────────────────────────────────

/**
 * When the session note body exceeds settings.recall.layer1MaxTokens, run a
 * cheap LLM call to re-summarise it in-place using the mode-specific template.
 * This prevents unbounded L1 growth while preserving all currently-relevant state.
 *
 * Non-fatal: caller wraps in try/catch. Failure leaves the note verbose until
 * the next extraction has another chance to compact it.
 */
async function compactSessionNoteIfNeeded(
  deps: ExtractionPipelineDeps,
  sessionId: SessionId,
  mode: TurnMode,
  signal?: AbortSignal,
): Promise<void> {
  const row = deps.memory.sessionNotes.findBySession(sessionId);
  if (!row) return;

  const entries = safeParseEntries(row.body);
  if (entries.length === 0) return;

  const totalTokens = estimateTextTokens(entries.map(e => e.delta).join('\n'));
  if (totalTokens <= deps.settings.recall.layer1MaxTokens) return;

  // 策略：
  // 1. 超过 30 天的 entry 直接丢弃（时效性极低）
  // 2. 其余旧 entries（超过 layer1MaxTokens 一半以上的部分）
  //    用 LLM 摘要成一条 merged entry
  // 3. 保留最近 keepRecent 条不压缩
  const expiry_days = deps.settings.recall.layer1EntryExpiryDays;
  const keep_recent = deps.settings.recall.layer1KeepRecentEntries;

  const cutoff = Date.now() - expiry_days * 86400_000;

  const fresh = entries.filter(e => e.at > cutoff);
  const tail  = fresh.slice(-keep_recent);
  const toMerge = fresh.slice(0, -keep_recent);

  if (toMerge.length === 0) return;

  const binding = resolveMemoryBindingLocal(deps);
  if (!binding) return;

  const mergeText = toMerge.map(e => e.delta).join('\n\n');
  const prompt = buildNoteCompactionPrompt({ mode, body: mergeText });
  const completion = await deps.memory.llm.complete({
    providerId: binding.providerId,
    model: binding.model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 800,
    temperature: 0.2,
    signal,
  });
  const merged = completion.blocks
    .filter((b): b is typeof b & { type: 'text' } => b.type === 'text')
    .map(b => b.text).join('').trim();

  if (!merged) return;

  // 把摘要放成一条最早时间的 entry，后面跟上保留的 tail
  const mergedEntry: SessionNoteEntry = {
    at:     toMerge[0]!.at,
    turnId: 'compacted',
    delta:  merged,
  };
  const compacted = [mergedEntry, ...tail];

  const now = Date.now();
  deps.memory.sessionNotes.upsert({
    sessionId,
    body: JSON.stringify(compacted),
    tokensAtLastUpdate: estimateTextTokens(compacted.map(e => e.delta).join('\n')),
    updatedAt: now,
  });
}

function resolveMemoryBindingLocal(
  deps: ExtractionPipelineDeps,
): { providerId: string; model: string } | null {
  const binding = deps.memory.modelBindings.get('memory') ?? deps.memory.modelBindings.get('compaction');
  if (binding) return { providerId: binding.providerConfigId, model: binding.model };
  const providerId = deps.memory.llm.firstProviderId();
  if (!providerId) return null;
  const model = deps.memory.llm.defaultModelFor(providerId);
  if (!model) return null;
  return { providerId, model };
}

// Surface the type for orchestrators wanting to type the result
export type { MemoryNodeRow, MemoryNodeType };
