import type { NarrativeChunkVectorRow } from '@ema-agent/storage';
import { COSINE_THRESHOLD, VECTOR_CHUNK_TOP_K } from '../constants.js';
import { rankVectors } from '../vectors.js';

/** rows 是 naive 的单周目向量或 mix 的全库向量. 正文由 search 按候选 ID 读取. */
export function retrieveNaive(
  embedding: Float32Array,
  rows: readonly NarrativeChunkVectorRow[],
  signal: AbortSignal,
): string[] {
  return rankVectors(
    rows.map(row => row.chunk_id),
    rows.map(row => row.vector),
    embedding,
    VECTOR_CHUNK_TOP_K,
    COSINE_THRESHOLD,
    signal,
  );
}
