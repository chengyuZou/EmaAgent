import crypto from 'node:crypto';
import type { SessionId } from '@ema-agent/contracts';
import type { EmbeddedText } from '../types.js';
import type { ExtractedNode, ExtractionOutput, PendingFragment } from './types.js';
import { unpackEmbedding } from '../embed/similarity.js';
import type { ExtractionPipelineDeps, PipelineResult } from './pipeline.js';

const NODE_DEDUP_THRESHOLD = 0.85;

export function processNodes(
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

export function routeCandidateNode(
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
  if (embedded && deps.nodesIndex && deps.indexSpaceId === embedded.space.id && deps.nodesIndex.dim === embedded.dim) {
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
      embeddingNormalization: embedded?.space.normalization,
      embeddingRevision:      embedded?.space.revision,
      embeddingSpaceId:       embedded?.space.id,
      importance:  candidate.importance,
      createdAt:   now,
    });
    // Update in-memory vector index too
    if (embedded && deps.nodesIndex && deps.indexSpaceId === embedded.space.id && deps.nodesIndex.dim === embedded.dim) {
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

export function enqueueLazyUpdate(
  deps: ExtractionPipelineDeps,
  nodeId: string,
  candidate: ExtractedNode,
  fragments: PendingFragment[],
  sessionId: SessionId,
  stats: PipelineResult,
): void {
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
