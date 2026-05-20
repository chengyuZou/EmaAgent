import crypto from 'node:crypto';
import type { SessionId, TurnMode } from '@ema-agent/contracts';
import type {
  MemoryNodeType,
  MemoryNodeRow,
} from '@ema-agent/storage';
import type { MemoryDeps } from '../deps.js';
import type { MemorySettings } from '../types.js';
import type {
  ExtractionOutput, ExtractedNode, PendingFragment,
} from './types.js';
import { runExtraction, runConsolidation } from './llm-call.js';
import {
  buildExtractionPrompt, buildConsolidationPrompt,
} from './prompts.js';
import { readPending, clearPending } from './pending.js';
import { EmbedService } from '../embed/service.js';
import { unpackEmbedding } from '../embed/similarity.js';
import type { VectorIndex } from '../index/vector-index.js';

// ── Configuration knobs (mode-dependent) ─────────────────────────────────────

const NODE_DEDUP_THRESHOLD = 0.85;   // cosine sim above this → treat as duplicate

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
  const empty: PipelineResult = {
    extractedNodes:    0,
    extractedEdges:    0,
    extractedItems:    0,
    lazyUpdatesQueued: 0,
    consolidatedNodes: 0,
  };

  const fragments = readPending(deps.memory.sessions, args.sessionId);
  if (fragments.length === 0) return empty;

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
    clearPending(deps.memory.sessions, args.sessionId, Date.now());
    return empty;
  }

  // ── 2. Route outputs ──────────────────────────────────────────────────────
  const stats = { ...empty };

  // Track labels of nodes that exist (existing + newly created) so edges can
  // resolve their endpoints. Keyed by label string.
  const labelToNodeId = new Map<string, string>();
  for (const n of existingNodes) labelToNodeId.set(n.label, n.id);

  // Process new_nodes — embed, dedup, route to either lazy_updates or insert
  await processNodes(deps, args.sessionId, output, fragments, stats, labelToNodeId, args.signal);

  // Process new_edges using the now-fresh labelToNodeId map
  processEdges(deps, output, stats, labelToNodeId);

  // Process memory_items — embed + insert (no dedup in V1; future round may
  // add it once we have a clear signal of "same item")
  await processItems(deps, args.sessionId, args.mode, output, stats, args.signal);

  // Process session_note_delta — append to session_notes.body
  if (output.session_note_delta.trim()) {
    appendSessionNote(deps, args.sessionId, output.session_note_delta);
  }

  // ── 3. Consolidate any nodes with lazy_updates ────────────────────────────
  // When the session opts out of consolidation, lazy_updates are still queued
  // by step 2; they just stay pending until a future extraction (with
  // consolidation re-enabled) drains them. No data loss.
  if (!args.skipConsolidation) {
    stats.consolidatedNodes = await consolidatePendingNodes(deps, args.signal);
  }

  // ── 4. Clear pending fragments — extraction is fully drained ──────────────
  clearPending(deps.memory.sessions, args.sessionId, Date.now());

  return stats;
}

// ── Node processing (dedup via embedding + lazy_updates) ─────────────────────

async function processNodes(
  deps: ExtractionPipelineDeps,
  sessionId: SessionId,
  output: ExtractionOutput,
  fragments: PendingFragment[],
  stats: PipelineResult,
  labelToNodeId: Map<string, string>,
  _signal?: AbortSignal,
): Promise<void> {
  if (output.new_nodes.length === 0) return;

  // Batch-embed the candidate node descriptions to save round-trips
  const texts = output.new_nodes.map(n => `${n.label}: ${n.description}`);
  const embeddings = await deps.embed.embedMany(texts);

  for (let i = 0; i < output.new_nodes.length; i++) {
    const candidate = output.new_nodes[i]!;
    const embedded  = embeddings?.[i] ?? null;
    await routeCandidateNode(
      deps, sessionId, candidate, embedded, fragments, stats, labelToNodeId,
    );
  }
}

async function routeCandidateNode(
  deps: ExtractionPipelineDeps,
  sessionId: SessionId,
  candidate: ExtractedNode,
  embedded: { embedding: Buffer; providerId: string; model: string; dim: number } | null,
  fragments: PendingFragment[],
  stats: PipelineResult,
  labelToNodeId: Map<string, string>,
): Promise<void> {
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

  // 3. Insert as new node
  const id  = crypto.randomUUID();
  const now = Date.now();
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

async function processItems(
  deps: ExtractionPipelineDeps,
  sessionId: SessionId,
  mode: TurnMode,
  output: ExtractionOutput,
  stats: PipelineResult,
  _signal?: AbortSignal,
): Promise<void> {
  if (output.memory_items.length === 0) return;

  const texts = output.memory_items.map(i => `${i.title}: ${i.body}`);
  const embeddings = await deps.embed.embedMany(texts);

  const modes = inferModesForMode(mode);
  for (let i = 0; i < output.memory_items.length; i++) {
    const item = output.memory_items[i]!;
    const e    = embeddings?.[i] ?? null;
    const id   = crypto.randomUUID();
    const now  = Date.now();

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
): void {
  const existing = deps.memory.sessionNotes.findBySession(sessionId);
  const now = Date.now();
  const sep = existing && existing.body.trim() ? '\n\n' : '';
  const body = (existing?.body ?? '') + sep + delta.trim();
  deps.memory.sessionNotes.upsert({
    sessionId,
    body,
    tokensAtLastUpdate: 0,    // updated by compaction pipeline
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

// Surface the type for orchestrators wanting to type the result
export type { MemoryNodeRow, MemoryNodeType };
