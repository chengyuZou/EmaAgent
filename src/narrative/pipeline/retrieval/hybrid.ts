import type { NarrativeGraphRepo, NarrativeTimelineId } from '@ema-agent/storage';
import type { NarrativeGraphResult } from '../../types.js';
import { retrieveGlobal } from './global.js';
import { retrieveLocal } from './local.js';
import { mergeAlternating } from './merge.js';

/** hybrid 搜索实体和关系; 缺少哪一侧就不执行哪一侧, 再交替合并去重. */
export function retrieveHybrid(
  timeline: NarrativeTimelineId,
  lowEmbedding: Float32Array | undefined,
  highEmbedding: Float32Array | undefined,
  graph: NarrativeGraphRepo,
  signal: AbortSignal,
): NarrativeGraphResult {
  let local: NarrativeGraphResult = { entities: [], relations: [] };
  let global: NarrativeGraphResult = { entities: [], relations: [] };
  if (lowEmbedding) {
    local = retrieveLocal(timeline, lowEmbedding, graph, signal);
  }
  if (highEmbedding) {
    global = retrieveGlobal(timeline, highEmbedding, graph, signal);
  }
  return {
    entities: mergeAlternating([local.entities, global.entities], entity => entity.entity_name),
    relations: mergeAlternating([local.relations, global.relations], relation => relation.relation_id),
  };
}
