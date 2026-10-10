import type {
  NarrativeChunksRepo,
  NarrativeGraphRepo,
  NarrativeKeywords,
  NarrativeTimelineId,
} from '@ema-agent/storage';
import type { NarrativeGraphResult, NarrativeQueryMode } from '../types.js';
import { buildContext, truncateGraph } from './context.js';
import { retrieveGlobal } from './retrieval/global.js';
import { retrieveHybrid } from './retrieval/hybrid.js';
import { retrieveLocal } from './retrieval/local.js';
import { mergeAlternating } from './retrieval/merge.js';
import { retrieveMix } from './retrieval/mix.js';
import { retrieveNaive } from './retrieval/naive.js';
import { retrieveSourceChunks } from './retrieval/sourceChunks.js';

/** 返回当前模式实际消费的编码文本. query 用于直接块搜索和图来源选块, 关键词用于实体/关系搜索. */
export function embeddingTexts(
  query: string,
  mode: NarrativeQueryMode,
  keywords: NarrativeKeywords,
): string[] {
  if (mode === 'naive') {
    return [query];
  }
  const low = keywords.lowLevelKeywords.join(', ');
  const high = keywords.highLevelKeywords.join(', ');
  if (!low && !high) {
    // TODO: 确认 mix 在两组关键词都为空时是否仍编码子问题并执行直接块搜索; 当前与图模式一样返回空背景.
    return [];
  }
  if (mode === 'local' && low) {
    return [query, low];
  }
  if (mode === 'global' && high) {
    return [query, high];
  }
  // local/global 缺少本侧关键词时, 原生会进入双路分支; 这里只编码实际使用的词.
  return [query, low, high].filter(text => text.length > 0);
}

/**
 * 查询单个周目. embeddings 是本次批量编码的文本到向量映射, 不在此处调用模型.
 * 全量块向量只在 naive/mix 中读取; mix 的直接块搜索和来源选块共用本次读取的数据.
 */
export function queryTimeline(
  timeline: NarrativeTimelineId,
  query: string,
  mode: NarrativeQueryMode,
  keywords: NarrativeKeywords,
  embeddings: ReadonlyMap<string, Float32Array>,
  chunks: NarrativeChunksRepo,
  graph: NarrativeGraphRepo,
  signal: AbortSignal,
): string {
  signal.throwIfAborted();
  const queryEmbedding = embeddings.get(query);
  if (!queryEmbedding) {
    // 图模式没有可用关键词时不会编码子问题, 因此不读剧情资产; 不是一次检索失败.
    return '';
  }
  const chunkVectors = mode === 'naive' || mode === 'mix' ? chunks.listVectors(timeline) : undefined;
  if (mode === 'naive') {
    const ids = retrieveNaive(queryEmbedding, chunkVectors!, signal);
    return buildContext({ entities: [], relations: [] }, chunks.findChunksByIds(timeline, ids), true);
  }
  const low = embeddings.get(keywords.lowLevelKeywords.join(', '));
  const high = embeddings.get(keywords.highLevelKeywords.join(', '));
  let found: NarrativeGraphResult;
  let vectorChunkIds: string[] = [];
  if (mode === 'local' && low) {
    found = retrieveLocal(timeline, low, graph, signal);
  } else if (mode === 'global' && high) {
    found = retrieveGlobal(timeline, high, graph, signal);
  } else if (mode === 'mix') {
    const mixed = retrieveMix(timeline, queryEmbedding, low, high, chunkVectors!, graph, signal);
    found = mixed;
    vectorChunkIds = mixed.vectorChunkIds;
  } else {
    found = retrieveHybrid(timeline, low, high, graph, signal);
  }
  // 先限制实体/关系背景长度, 再查来源块, 不为已被长度限制排除的图结果读取正文.
  const filtered = truncateGraph(found);
  const source = retrieveSourceChunks(
    timeline,
    filtered.entities.map(entity => entity.entity_name),
    filtered.relations.map(relation => relation.relation_id),
    graph, chunks, queryEmbedding, signal, chunkVectors,
  );
  const ids = mergeAlternating([
    vectorChunkIds,
    source.entityChunks,
    source.relationChunks,
  ], id => id);
  const selected = chunks.findChunksByIds(timeline, ids);
  signal.throwIfAborted();
  return buildContext(filtered, selected, false);
}
