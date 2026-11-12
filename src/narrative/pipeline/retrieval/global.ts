import type { NarrativeGraphRepo } from '@ema-agent/storage';
import type { NarrativeGraphResult } from '../../types.js';
import { COSINE_THRESHOLD, TOP_K } from '../constants.js';
import { rankVectors } from '../vectors.js';

/** global 是对主题, 事件等高层关键词的检索, 用来找关系; 再读取关系两端实体. */
export function retrieveGlobal(
  embedding: Float32Array,
  graph: NarrativeGraphRepo,
  signal: AbortSignal,
): NarrativeGraphResult {
  signal.throwIfAborted();

  // 高层关键词先匹配关系, 返回值是按相似度排列的关系 ID.
  const rows = graph.listRelationVectors();
  const ids = rankVectors(
    rows.map(row => row.relation_id),
    rows.map(row => row.vector),
    embedding,
    TOP_K,
    COSINE_THRESHOLD,
    signal,
  );
  const relations = graph.findRelations(ids);

  // 多条关系可能指向同一个实体. 两端名称去重后再读取实体描述.
  const endpointNames = relations.flatMap(relation => [
    relation.source_entity,
    relation.target_entity,
  ]);
  const names = [...new Set(endpointNames)];
  const entities = graph.findEntities(names);
  return { entities, relations };
}
