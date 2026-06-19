export interface RankedHit { id: string; score: number }

/**
 * WeightedRanker: merge BM25 and vector results.
 * Both score lists are min-max normalized to [0,1] before blending.
 * alpha = 0 → pure BM25, alpha = 1 → pure vector.
 */
export function weightedRank(
  sparse: Array<{ id: string; score: number }>,
  dense:  Array<{ id: string; score: number }>,
  alpha = 0.5,
  topK  = 10,
): RankedHit[] {
  const normS = normalize(sparse);
  const normD = normalize(dense);

  const merged = new Map<string, number>();
  for (const { id, score } of normS) merged.set(id, (1 - alpha) * score);
  for (const { id, score } of normD) merged.set(id, (merged.get(id) ?? 0) + alpha * score);

  return [...merged.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, topK)
    .map(([id, score]) => ({ id, score }));
}

function normalize(hits: Array<{ id: string; score: number }>): Array<{ id: string; score: number }> {
  if (hits.length === 0) return [];
  const scores = hits.map(h => h.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  if (range === 0) return hits.map(h => ({ ...h, score: 1 }));
  return hits.map(h => ({ id: h.id, score: (h.score - min) / range }));
}
