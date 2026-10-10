import type {
  NarrativeChunkVectorRow,
  NarrativeGraphRepo,
  NarrativeTimelineId,
} from '@ema-agent/storage';
import type { NarrativeGraphResult } from '../../types.js';
import { retrieveHybrid } from './hybrid.js';
import { retrieveNaive } from './naive.js';

/** 图搜索使用关键词向量, 直接块搜索使用路由后的子问题向量; chunkVectors 仅在本次查询内复用. */
export function retrieveMix(
  timeline: NarrativeTimelineId,
  queryEmbedding: Float32Array,
  lowEmbedding: Float32Array | undefined,
  highEmbedding: Float32Array | undefined,
  chunkVectors: readonly NarrativeChunkVectorRow[],
  graph: NarrativeGraphRepo,
  signal: AbortSignal,
): NarrativeGraphResult & { vectorChunkIds: string[] } {
  return {
    ...retrieveHybrid(timeline, lowEmbedding, highEmbedding, graph, signal),
    vectorChunkIds: retrieveNaive(queryEmbedding, chunkVectors, signal),
  };
}
