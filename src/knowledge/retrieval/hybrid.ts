export interface RankedHit { id: string; score: number }

const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: merge BM25 and vector results by rank position.
 * More robust than min-max score blending — unaffected by score distribution skew.
 * alpha = 0 → pure BM25, alpha = 1 → pure vector, 0.5 → equal weight.
 */
export function weightedRank(
  sparse: Array<{ id: string; score: number }>,
  dense:  Array<{ id: string; score: number }>,
  alpha = 0.5,
  topK  = 10,
): RankedHit[] {
  const sortedSparse = [...sparse].sort((a, b) => b.score - a.score);
  const sortedDense  = [...dense].sort((a, b) => b.score - a.score);

  const sparseRank = new Map(sortedSparse.map((h, i) => [h.id, i]));
  const denseRank  = new Map(sortedDense.map((h, i) => [h.id, i]));

  const allIds = new Set([...sparse.map(h => h.id), ...dense.map(h => h.id)]);

  const merged = new Map<string, number>();
  for (const id of allIds) {
    const sr = sparseRank.has(id) ? (1 - alpha) / (RRF_K + sparseRank.get(id)!) : 0;
    const dr = denseRank.has(id)  ? alpha       / (RRF_K + denseRank.get(id)!)  : 0;
    merged.set(id, sr + dr);
  }

  return [...merged.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, topK)
    .map(([id, score]) => ({ id, score }));
}
