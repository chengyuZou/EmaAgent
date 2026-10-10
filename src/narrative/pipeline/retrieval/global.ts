import type { NarrativeGraphRepo, NarrativeTimelineId } from '@ema-agent/storage';
import type { NarrativeGraphResult } from '../../types.js';
import { COSINE_THRESHOLD, TOP_K } from '../constants.js';
import { rankVectors } from '../vectors.js';

/** global 是对主题, 事件等高层关键词的检索, 用来找关系; 再读取关系两端实体. */
export function retrieveGlobal(
  timeline: NarrativeTimelineId,
  embedding: Float32Array,
  graph: NarrativeGraphRepo,
  signal: AbortSignal,
): NarrativeGraphResult {
  signal.throwIfAborted();
  const rows = graph.listRelationVectors(timeline);
  const ids = rankVectors(
    rows.map(row => row.relation_id), rows.map(row => row.vector),
    embedding, TOP_K, COSINE_THRESHOLD, signal,
  );
  const relations = graph.findRelations(timeline, ids);
  const names = [...new Set(relations.flatMap(relation => [relation.source_entity, relation.target_entity]))];
  const entities = graph.findEntities(timeline, names);
  return { entities, relations };
}
