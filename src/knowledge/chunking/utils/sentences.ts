// CJK sentence split on 。！？!? plus standard ASCII terminals.
const SENT_BOUNDARY = /(?<=[.!?。！？]+)\s+|(?<=[。！？])/u;

export function splitSentences(text: string): string[] {
  return text.split(SENT_BOUNDARY).map(s => s.trim()).filter(Boolean);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return NaN;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? NaN : dot / denom;
}

export function smoothSimilarities(sims: number[], window: number): number[] {
  if (window <= 1) return sims;
  return sims.map((_, i) => {
    const lo = Math.max(0, i - window + 1);
    const slice = sims.slice(lo, i + 1).filter(Number.isFinite);
    return slice.length === 0 ? NaN : slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

export function percentile(values: number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)]!;
}
