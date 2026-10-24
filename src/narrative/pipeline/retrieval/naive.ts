import type { NarrativeChunkVectorRow } from '@ema-agent/storage';
import { COSINE_THRESHOLD, VECTOR_CHUNK_TOP_K } from '../constants.js';
import { rankVectors } from '../vectors.js';

/** embedding 来自传入的 query, rows 是本周目的全部块向量. 只返回 ID, 正文由查询流程统一批量读取. */
export function retrieveNaive(
  embedding: Float32Array,
  rows: readonly NarrativeChunkVectorRow[],
  signal: AbortSignal,
): string[] {
  return rankVectors(
    rows.map(row => row.chunk_id), rows.map(row => row.vector),
    embedding, VECTOR_CHUNK_TOP_K, COSINE_THRESHOLD, signal,
  );
}
