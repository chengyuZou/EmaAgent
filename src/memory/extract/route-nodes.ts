import crypto from 'node:crypto';
import type { SessionId } from '@ema-agent/ids';
import type { EmbeddedText } from '../types.js';
import type { ExtractedNode, ExtractionOutput, PendingFragment } from './types.js';
import { unpackEmbedding } from '../embed/similarity.js';
import type { ExtractionPipelineDeps, PipelineResult } from './pipeline.js';
import type { PendingIndexMutation } from './index-mutations.js';
import type { NodeDirectory } from './node-directory.js';
import { judgeDuplicateEntity } from './duplicate-judgment.js';

const NODE_DEDUP_THRESHOLD = 0.85;

/** 事务前对单个 embedding 疑似重复做出的判定。 */
export interface NodeDuplicateJudgment {
  targetNodeId: string;
  merge: boolean;
}

/**
 * 事务前阶段：为每个 embedding 疑似重复的候选完成 LLM 同一性判定。
 * embedding 只负责粗筛候选；"是否同一实体"由 LLM 判断——
 * 字面相近但语义域不同（"苹果手机"与"苹果"）不应归并。
 */
export async function planNodeDuplicateJudgments(
  deps: ExtractionPipelineDeps,
  output: ExtractionOutput,
  embeddings: EmbeddedText[] | null,
): Promise<Map<number, NodeDuplicateJudgment>> {
  const judgments = new Map<number, NodeDuplicateJudgment>();
  for (let i = 0; i < output.new_nodes.length; i++) {
    const candidate = output.new_nodes[i]!;
    // label 精确命中在事务内新鲜判断；这里只处理 embedding 疑似重复。
    if (deps.memory.nodes.findByLabelAndType(candidate.label, candidate.nodeType)) continue;
    const embedded = embeddings?.[i] ?? null;
    if (!embedded || !deps.nodesIndex || deps.indexSpaceId !== embedded.space.id) continue;
    if (deps.nodesIndex.dim !== embedded.dim) continue;
    const view = unpackEmbedding(embedded.embedding, embedded.dim);
    const best = deps.nodesIndex.search(view, 1)[0];
    if (!best || best.score < NODE_DEDUP_THRESHOLD) continue;
    const existing = deps.memory.nodes.findById(best.id);
    if (!existing || existing.node_type !== candidate.nodeType) continue;

    const merge = await judgeDuplicateEntity(
      deps.memory.llm,
      deps.memory.modelBindings,
      {
        candidateLabel: candidate.label,
        candidateDescription: candidate.description,
        existingLabel: existing.label,
        existingDescription: existing.description ?? '',
      },
    );
    // 判定不可用（null）时保守新建，与判否同路。
    judgments.set(i, { targetNodeId: existing.id, merge: merge === true });
  }
  return judgments;
}

export function processNodes(
  deps: ExtractionPipelineDeps,
  sessionId: SessionId,
  output: ExtractionOutput,
  fragments: PendingFragment[],
  stats: PipelineResult,
  directory: NodeDirectory,
  precomputedEmbeddings: EmbeddedText[] | null,
  indexMutations: PendingIndexMutation[],
  duplicateJudgments: ReadonlyMap<number, NodeDuplicateJudgment>,
): void {
  for (let i = 0; i < output.new_nodes.length; i++) {
    const candidate = output.new_nodes[i]!;
    const embedded  = precomputedEmbeddings?.[i] ?? null;
    routeCandidateNode(
      deps,
      sessionId,
      candidate,
      embedded,
      fragments,
      stats,
      directory,
      indexMutations,
      duplicateJudgments.get(i),
    );
  }
}

export function routeCandidateNode(
  deps: ExtractionPipelineDeps,
  sessionId: SessionId,
  candidate: ExtractedNode,
  embedded: EmbeddedText | null,
  fragments: PendingFragment[],
  stats: PipelineResult,
  directory: NodeDirectory,
  indexMutations: PendingIndexMutation[],
  judgment?: NodeDuplicateJudgment,
): void {
  // 1. Cheap label match first
  const labelHit = deps.memory.nodes.findByLabelAndType(candidate.label, candidate.nodeType);
  if (labelHit) {
    enqueueLazyUpdate(deps, labelHit.id, candidate, fragments, sessionId, stats);
    directory.register(candidate.label, candidate.nodeType, labelHit.id);
    return;
  }

  // 2. Embedding 疑似重复：以事务前的 LLM 判定为准。
  // 判否或判定失败都保守新建，不回到纯相似度归并。
  if (judgment?.merge) {
    const existing = deps.memory.nodes.findById(judgment.targetNodeId);
    if (existing && existing.node_type === candidate.nodeType) {
      enqueueLazyUpdate(deps, existing.id, candidate, fragments, sessionId, stats);
      directory.register(candidate.label, candidate.nodeType, existing.id);
      return;
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
    // SQLite 提交后再更新派生向量索引，避免回滚留下幽灵向量。
    if (embedded && deps.nodesIndex && deps.indexSpaceId === embedded.space.id && deps.nodesIndex.dim === embedded.dim) {
      const view = unpackEmbedding(embedded.embedding, embedded.dim);
      indexMutations.push({ index: deps.nodesIndex, operation: 'add', id, vector: view });
    }
    // 新节点登记首条溯源：该事实来自哪个 Session/Turn。
    deps.memory.nodeSources.record(id, sessionId, fragments[0]?.turnId ?? null, now);
    directory.register(candidate.label, candidate.nodeType, id);
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
      directory.register(candidate.label, candidate.nodeType, existing.id);
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
  // 既有节点同样累积溯源：追加证据的来源与 lazy fragment 同源登记。
  deps.memory.nodeSources.record(nodeId, sessionId, source?.turnId ?? null, Date.now());
  stats.lazyUpdatesQueued++;
}
