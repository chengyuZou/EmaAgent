import type { NarrativeChunkVectorRow } from '@ema-agent/storage';
import { CHUNK_TOP_K, COSINE_THRESHOLD } from '../constants.js';
import { rankVectors } from '../vectors.js';

/** embedding 来自路由后的子问题, rows 是本周目的全部块向量. 只返回 ID, 正文由查询流程统一批量读取. */
export function retrieveNaive(
  embedding: Float32Array,
  rows: readonly NarrativeChunkVectorRow[],
  signal: AbortSignal,
): string[] {
  return rankVectors(
    rows.map(row => row.chunk_id), rows.map(row => row.vector),
    embedding, CHUNK_TOP_K, COSINE_THRESHOLD, signal,
  );
}
