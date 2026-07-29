import type { ExtractionPipelineDeps } from './pipeline.js';
import { buildConsolidationPrompt } from './prompts.js';
import { runConsolidation } from './llm-call.js';
import { unpackEmbedding } from '../embed/similarity.js';

export async function consolidatePendingNodes(
  deps: ExtractionPipelineDeps,
  signal?: AbortSignal,
  assertWritable?: () => void,
): Promise<number> {
  const nodeIds = deps.memory.lazyUpdates.listNodesWithPending();
  let consolidated = 0;

  for (const nodeId of nodeIds) {
    const node = deps.memory.nodes.findById(nodeId);
    if (!node) {
      // Node deleted between extraction and consolidation — drop the orphans
      const stale = deps.memory.lazyUpdates.listByNode(nodeId);
      assertWritable?.();
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
    // 两次模型调用都在锁内等待，期间租约仍可能易主；写业务表前再次关闸。
    assertWritable?.();
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
        embeddingNormalization: reEmbed.space.normalization,
        embeddingRevision:      reEmbed.space.revision,
        embeddingSpaceId:       reEmbed.space.id,
        updatedAt:           now,
      });
      if (deps.nodesIndex && deps.indexSpaceId === reEmbed.space.id && deps.nodesIndex.dim === reEmbed.dim) {
        const view = unpackEmbedding(reEmbed.embedding, reEmbed.dim);
        deps.nodesIndex.update(node.id, view);
      }
    }

    // Drain only the rows we actually consolidated — new arrivals stay.
    // 溯源链不受影响：来源在 lazy update 追加时已登记进 memory_node_sources。
    deps.memory.lazyUpdates.deleteByIds(updates.map(u => u.id));
    consolidated++;
  }

  return consolidated;
}
