import type {
  NarrativeChunksRepo,
  NarrativeGraphRepo,
  NarrativeTimelineId,
} from '@ema-agent/storage';
import type {
  NarrativeGraphResult,
  NarrativeKeywords,
  NarrativeQueryMode,
} from '../types.js';
import { RERANK_CANDIDATE_LIMIT } from './constants.js';
import { retrieveGlobal } from './retrieval/global.js';
import { retrieveHybrid } from './retrieval/hybrid.js';
import { retrieveLocal } from './retrieval/local.js';
import { mergeAlternating } from './retrieval/merge.js';
import { retrieveMix } from './retrieval/mix.js';
import { retrieveSourceChunks } from './retrieval/sourceChunks.js';

/** 返回当前模式实际消费的编码文本. query 用于直接块搜索和图来源选块, 关键词用于实体/关系搜索. */
export function collectEmbeddingTexts(
  query: string,
  mode: Exclude<NarrativeQueryMode, 'naive'>,
  keywords: NarrativeKeywords,
): string[] {
  const low = keywords.lowLevelKeywords.join(', ');
  const high = keywords.highLevelKeywords.join(', ');
  if (!low && !high) {
    // TODO: 确认 mix 在两组关键词都为空时是否仍编码 query 并执行直接块搜索; 当前与图模式一样返回空背景.
    return [];
  }
  if (mode === 'local' && low) {
    return [query, low];
  }
  if (mode === 'global' && high) {
    return [query, high];
  }
  // local/global 缺少本侧关键词时使用另一侧, 这里只编码实际要用的文本.
  return [query, low, high].filter(text => text.length > 0);
}

/** 同步查询全局图. 来源块向量行带有周目, 可以在读正文前限制每组候选数. */
export function queryGraphCandidates(
  query: string,
  mode: Exclude<NarrativeQueryMode, 'naive'>,
  keywords: NarrativeKeywords,
  embeddings: ReadonlyMap<string, Float32Array>,
  chunks: NarrativeChunksRepo,
  graph: NarrativeGraphRepo,
  signal: AbortSignal,
): NarrativeGraphResult & { chunkIdsByTimeline: ReadonlyMap<NarrativeTimelineId, string[]> } {
  signal.throwIfAborted();
  const queryEmbedding = embeddings.get(query)!;
  const chunkVectors = mode === 'mix' ? chunks.listVectors() : undefined;
  const low = embeddings.get(keywords.lowLevelKeywords.join(', '));
  const high = embeddings.get(keywords.highLevelKeywords.join(', '));
  let found: NarrativeGraphResult;
  let vectorChunkIds: string[] = [];
  if (mode === 'local' && low) {
    found = retrieveLocal(low, graph, signal);
  } else if (mode === 'global' && high) {
    found = retrieveGlobal(high, graph, signal);
  } else if (mode === 'mix') {
    const mixed = retrieveMix(queryEmbedding, low, high, chunkVectors!, graph, signal);
    found = mixed;
    vectorChunkIds = mixed.vectorChunkIds;
  } else {
    found = retrieveHybrid(low, high, graph, signal);
  }
  // 用命中的实体和关系找来源块. 图描述长度不影响来源块是否进入候选.
  const source = retrieveSourceChunks(
    found.entities.map(entity => entity.entity_name),
    found.relations.map(relation => relation.relation_id),
    graph,
    chunks,
    queryEmbedding,
    signal,
    chunkVectors,
  );

  // 从直接搜索、实体来源和关系来源中轮流取块.
  // 相同 chunk_id 只保留首次出现的位置, 避免某一路重复占用候选名额.
  const ids = mergeAlternating([
    vectorChunkIds,
    source.entityChunks,
    source.relationChunks,
  ], id => id);
  const chunkIdsByTimeline = new Map<NarrativeTimelineId, string[]>();
  for (const chunkId of ids) {
    const timelineId = source.chunkVectorsById.get(chunkId)?.timeline_id;
    if (timelineId === undefined) {
      continue;
    }
    const timelineChunkIds = chunkIdsByTimeline.get(timelineId);
    if (timelineChunkIds === undefined) {
      chunkIdsByTimeline.set(timelineId, [chunkId]);
    } else if (timelineChunkIds.length < RERANK_CANDIDATE_LIMIT) {
      timelineChunkIds.push(chunkId);
    }
  }
  signal.throwIfAborted();
  return { ...found, chunkIdsByTimeline };
}
