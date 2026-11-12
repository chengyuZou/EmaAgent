import type { NarrativeGraphRepo } from '@ema-agent/storage';
import type { NarrativeGraphResult } from '../../types.js';
import { COSINE_THRESHOLD, TOP_K } from '../constants.js';
import { rankVectors } from '../vectors.js';
import { mergeAlternating } from './merge.js';

// local 先用低层关键词寻找实体, 再读取这些实体连接的关系.
export function retrieveLocal(
  embedding: Float32Array,
  graph: NarrativeGraphRepo,
  signal: AbortSignal,
): NarrativeGraphResult {
  signal.throwIfAborted();

  // 用关键词向量选出实体名, 再批量读取命中实体的描述.
  const entityVectorRows = graph.listEntityVectors();
  const entityNames = rankVectors(
    entityVectorRows.map(row => row.entity_name),
    entityVectorRows.map(row => row.vector),
    embedding,
    TOP_K,
    COSINE_THRESHOLD,
    signal,
  );
  const entities = graph.findEntities(entityNames);

  // 同一关系可能被多个实体带出. 按 relation_id 去重, 保留首次出现的位置.
  const relationsByEntity = graph.findIncidentRelations(
    entities.map(entity => entity.entity_name),
  );
  const relations = mergeAlternating(
    [[...relationsByEntity.values()].flat()],
    relation => relation.relation_id,
  );

  // 收集关系两端的实体名并去重, 然后一次查询它们各自的连接数.
  const endpointNames = relations.flatMap(relation => [
    relation.source_entity,
    relation.target_entity,
  ]);
  const uniqueEndpointNames = [...new Set(endpointNames)];
  const degrees = graph.getEntityDegrees(uniqueEndpointNames);

  // 两端实体的连接总数越多, 关系越靠前. 总数相同时再比较资产中的 weight.
  relations.sort((left, right) => {
    const leftRank =
      degrees.get(left.source_entity)! +
      degrees.get(left.target_entity)!;
    const rightRank =
      degrees.get(right.source_entity)! +
      degrees.get(right.target_entity)!;
    return rightRank - leftRank || right.weight - left.weight;
  });

  return { entities, relations };
}
