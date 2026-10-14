import type { NarrativeChunkRow, NarrativeEntityRow, NarrativeRelationRow } from '@ema-agent/storage';
import type { NarrativeGraphResult } from '../types.js';
import { MAX_ENTITY_CHARACTERS, MAX_RELATION_CHARACTERS } from './constants.js';

// 保留完整项, 不截断原文. 长度包括 JSON 转义及项之间的换行.
function truncateByCharacters<T>(
  items: readonly T[],
  render: (item: T) => string,
  limit: number,
): T[] {
  let used = 0;
  const selected: T[] = [];
  for (const item of items) {
    const separator = selected.length > 0 ? 1 : 0;
    const length = render(item).length + separator;
    if (used + length > limit) {
      break;
    }
    used += length;
    selected.push(item);
  }
  return selected;
}

function renderEntity(entity: NarrativeEntityRow): string {
  return JSON.stringify({ entity: entity.entity_name, type: entity.entity_type, description: entity.description });
}

function renderRelation(relation: NarrativeRelationRow): string {
  return JSON.stringify({ entity1: relation.source_entity, entity2: relation.target_entity, description: relation.description });
}

// 图背景只用于确定来源块, 不随原文重复返回给主模型.
export function truncateGraph(graph: NarrativeGraphResult): NarrativeGraphResult {
  return {
    entities: truncateByCharacters(graph.entities, renderEntity, MAX_ENTITY_CHARACTERS),
    relations: truncateByCharacters(graph.relations, renderRelation, MAX_RELATION_CHARACTERS),
  };
}

export function buildContext(chunks: readonly NarrativeChunkRow[], characterLimit: number): string {
  const render = (chunk: NarrativeChunkRow): string => {
    return JSON.stringify({ chunk_id: chunk.chunk_id, content: chunk.content });
  };
  return truncateByCharacters(chunks, render, characterLimit).map(render).join('\n');
}
