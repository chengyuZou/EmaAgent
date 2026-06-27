import crypto from 'node:crypto';
import type { ExtractionOutput } from './types.js';
import type { ExtractionPipelineDeps, PipelineResult } from './pipeline.js';

export function processEdges(
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
