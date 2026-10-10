import type { NarrativeGraphRepo, NarrativeTimelineId } from '@ema-agent/storage';
import type { NarrativeGraphResult } from '../../types.js';
import { COSINE_THRESHOLD, TOP_K } from '../constants.js';
import { rankVectors } from '../vectors.js';
import { mergeAlternating } from './merge.js';

/** local 是具体人物等低层关键词的检索, 用来找实体; 相邻关系从图中读取, 不再做关系向量搜索. */
export function retrieveLocal(
  timeline: NarrativeTimelineId,
  embedding: Float32Array,
  graph: NarrativeGraphRepo,
  signal: AbortSignal,
): NarrativeGraphResult {
  signal.throwIfAborted();
  const rows = graph.listEntityVectors(timeline);
  const names = rankVectors(
    rows.map(row => row.entity_name), rows.map(row => row.vector),
    embedding, TOP_K, COSINE_THRESHOLD, signal,
  );
  const entities = graph.findEntities(timeline, names);
  const incident = graph.findIncidentRelations(timeline, entities.map(entity => entity.entity_name));
  // 同一关系可能被多个命中实体引用, 先去重. 两端连接数之和优先, 同分再按资产 weight 排序.
  const relations = mergeAlternating([[...incident.values()].flat()], relation => relation.relation_id);
  const endpoints = [...new Set(relations.flatMap(relation => [relation.source_entity, relation.target_entity]))];
  const degrees = graph.getEntityDegrees(timeline, endpoints);
  relations.sort((left, right) => {
    const leftRank = degrees.get(left.source_entity)! + degrees.get(left.target_entity)!;
    const rightRank = degrees.get(right.source_entity)! + degrees.get(right.target_entity)!;
    return rightRank - leftRank || right.weight - left.weight;
  });
  return { entities, relations };
}
