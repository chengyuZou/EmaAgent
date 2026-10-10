import type { NarrativeChunkRow, NarrativeEntityRow, NarrativeRelationRow } from '@ema-agent/storage';
import type { NarrativeGraphResult } from '../types.js';
import {
  CHUNK_TOP_K,
  MAX_ENTITY_CHARACTERS,
  MAX_RELATION_CHARACTERS,
  MAX_CONTEXT_CHARACTERS,
} from './constants.js';
import {
  GRAPH_CONTEXT_TEMPLATE,
  NAIVE_CONTEXT_TEMPLATE,
} from './prompts.js';

// 按召回优先级保留完整前缀, 第一项超限就停止, 不跳过它选后面的项或截断正文.
// render 的 JSON 转义和条目之间的换行都计入 limit, 单位是字符串 .length, 不是 token.
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
  return `{"entity": ${JSON.stringify(entity.entity_name)}, "type": ${JSON.stringify(entity.entity_type)}, "description": ${JSON.stringify(entity.description)}}`;
}

function renderRelation(relation: NarrativeRelationRow): string {
  return `{"entity1": ${JSON.stringify(relation.source_entity)}, "entity2": ${JSON.stringify(relation.target_entity)}, "description": ${JSON.stringify(relation.description)}}`;
}

function renderChunk(chunk: NarrativeChunkRow): string {
  // 固定资产没有文件路径, 与原生 unknown_source 一样不生成文件引用编号.
  return `{"reference_id": "", "content": ${JSON.stringify(chunk.content)}}`;
}

// naive 没有图背景, 使用仅含文本块的模板; 两种模板都只组织背景, 不请求模型生成回答.
function renderContext(graph: NarrativeGraphResult, text: string, naive: boolean): string {
  if (naive) {
    return NAIVE_CONTEXT_TEMPLATE.replace(/\{text_chunks_str\}|\{reference_list_str\}/g, placeholder => {
      return placeholder === '{text_chunks_str}' ? text : '';
    });
  }
  const entities = graph.entities.map(renderEntity).join('\n');
  const relations = graph.relations.map(renderRelation).join('\n');
  // 一次替换模板, 正文里即使含同名占位符也不会被再次替换.
  return GRAPH_CONTEXT_TEMPLATE.replace(/\{entities_str\}|\{relations_str\}|\{text_chunks_str\}|\{reference_list_str\}/g, placeholder => {
    switch (placeholder) {
      case '{entities_str}':
        return entities;
      case '{relations_str}':
        return relations;
      case '{text_chunks_str}':
        return text;
      default:
        return '';
    }
  });
}

// 实体和关系分别限制长度. 后续来源选块只使用保留下来的节点和边.
export function truncateGraph(graph: NarrativeGraphResult): NarrativeGraphResult {
  return {
    entities: truncateByCharacters(graph.entities, renderEntity, MAX_ENTITY_CHARACTERS),
    relations: truncateByCharacters(graph.relations, renderRelation, MAX_RELATION_CHARACTERS),
  };
}

export function buildContext(
  graph: NarrativeGraphResult,
  chunks: readonly NarrativeChunkRow[],
  naive: boolean,
): string {
  const available = MAX_CONTEXT_CHARACTERS - renderContext(graph, '', naive).length;
  // available 已扣除模板和图背景, 剩余才用于正文, 限制针对最终返回的整段文本.
  const selected = truncateByCharacters(
    chunks.slice(0, CHUNK_TOP_K),
    renderChunk,
    available,
  );
  if (graph.entities.length === 0 && graph.relations.length === 0 && selected.length === 0) {
    return '';
  }
  return renderContext(graph, selected.map(renderChunk).join('\n'), naive);
}
