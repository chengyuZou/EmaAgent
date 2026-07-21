import type { ExtractionPipelineDeps } from './pipeline.js';
import { buildConsolidationPrompt } from './prompts.js';
import { runConsolidation } from './llm-call.js';
import { unpackEmbedding } from '../embed/similarity.js';

export async function consolidatePendingNodes(
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

    // Drain only the rows we actually consolidated — new arrivals stay
    deps.memory.lazyUpdates.deleteByIds(updates.map(u => u.id));
    consolidated++;
  }

  return consolidated;
}
