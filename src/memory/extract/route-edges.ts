import crypto from 'node:crypto';
import type { MemoryNodeType } from '@ema-agent/storage';
import type { ExtractionOutput } from './types.js';
import type { ExtractionPipelineDeps, PipelineResult } from './pipeline.js';
import type { NodeDirectory } from './node-directory.js';

export function processEdges(
  deps: ExtractionPipelineDeps,
  output: ExtractionOutput,
  stats: PipelineResult,
  directory: NodeDirectory,
): void {
  for (const edge of output.new_edges) {
    const fromId = resolveEndpoint(directory, edge.fromLabel, edge.fromType);
    const toId   = resolveEndpoint(directory, edge.toLabel,   edge.toType);
    // 落点不明确就丢边并计数: 不许把边静默连到同名不同 type 的节点上(B-076)。
    if (!fromId || !toId) { stats.droppedEdges++; continue; }
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

/**
 * 边端点三级落点: 精确 (label, type) -> label 全库唯一兜底 -> 丢弃。
 * 模型没给 type 时只有 label 无歧义才放行; 有歧义又不给 type 的边丢弃,
 * 代价是一条边, 好过连错对象污染召回。
 */
function resolveEndpoint(
  directory: NodeDirectory,
  label: string,
  nodeType?: MemoryNodeType,
): string | undefined {
  if (nodeType) {
    const hit = directory.resolve(label, nodeType);
    if (hit) return hit;
  }
  return directory.resolveUnique(label);
}
