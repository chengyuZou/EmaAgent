import type { ExecutionProfile } from '@ema-agent/turn';
import crypto from 'node:crypto';
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { EmbeddedText } from '../types.js';
import type { ExtractionOutput } from './types.js';
import { unpackEmbedding } from '../embed/similarity.js';
import type { ExtractionPipelineDeps, PipelineResult } from './pipeline.js';
import type { PendingIndexMutation } from './index-mutations.js';

export function processItems(
  deps: ExtractionPipelineDeps,
  sessionId: SessionId,
  executionProfile: ExecutionProfile,
  output: ExtractionOutput,
  stats: PipelineResult,
  precomputedEmbeddings: EmbeddedText[] | null,
  extractionTurnId: TurnId,
  indexMutations: PendingIndexMutation[],
): void {
  if (output.memory_items.length === 0) return;

  const profiles = profilesForMemoryItem(executionProfile);
  for (let i = 0; i < output.memory_items.length; i++) {
    const item = output.memory_items[i]!;
    const e    = precomputedEmbeddings?.[i] ?? null;
    const now  = Date.now();

    const existing = deps.memory.items.findBySourceAndTitle(sessionId, item.title);

    if (existing) {
      // Same session + same title: distinguish retry from legitimate update.
      //   - Same turnId → retry of the same extraction → skip entirely.
      //   - Different turnId → knowledge evolved in a new turn → update body.
      if (existing.source_turn_id === extractionTurnId) continue;

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
        embeddingNormalization: e?.space.normalization,
        embeddingRevision:      e?.space.revision,
        embeddingSpaceId:       e?.space.id,
      });
      if (e && deps.itemsIndex && deps.indexSpaceId === e.space.id && deps.itemsIndex.dim === e.dim) {
        const view = unpackEmbedding(e.embedding, e.dim);
        indexMutations.push({
          index: deps.itemsIndex,
          operation: 'update',
          id: existing.id,
          vector: view,
        });
      }
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
      profiles,
      embedding:           e?.embedding,
      embeddingProviderId: e?.providerId,
      embeddingModel:      e?.model,
      embeddingDim:        e?.dim,
      embeddingNormalization: e?.space.normalization,
      embeddingRevision:      e?.space.revision,
      embeddingSpaceId:       e?.space.id,
      sourceSessionId:     sessionId,
      sourceTurnId:        extractionTurnId,
      importance:          item.importance,
      createdAt:           now,
    });

    if (e && deps.itemsIndex && deps.indexSpaceId === e.space.id && deps.itemsIndex.dim === e.dim) {
      const view = unpackEmbedding(e.embedding, e.dim);
      indexMutations.push({ index: deps.itemsIndex, operation: 'add', id, vector: view });
    }
    stats.extractedItems++;
  }
}

export function profilesForMemoryItem(executionProfile: ExecutionProfile): ExecutionProfile[] {
  return executionProfile === 'work' ? ['work', 'chat'] : ['chat'];
}
