// 语义 chunker 的纯函数工具：分句、余弦相似度、平滑与分位数；无状态，不依赖嵌入选型。

// 句界：CJK 句号/感叹/问号直接断；拉丁句点需后跟空白才算，避免小数点和缩写误断。
const SENT_BOUNDARY = /(?<=[.!?。！？]+)\s+|(?<=[。！？])/u;

export function splitSentences(text: string): string[] {
  return text.split(SENT_BOUNDARY).map(s => s.trim()).filter(Boolean);
}

/**
 * 余弦相似度。维度不齐或零向量返回 NaN 而不是 0：NaN 会被上层的失真守卫识别
 * （占比过半即整体降级），0 分则会被误当成真实的低相似度断点。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return NaN;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? NaN : dot / denom;
}

/** 尾随窗口（i-window+1 … i）均值平滑；window ≤ 1 时原样返回。 */
export function smoothSimilarities(sims: number[], window: number): number[] {
  if (window <= 1) return sims;
  return sims.map((_, i) => {
    const lo = Math.max(0, i - window + 1);
    const slice = sims.slice(lo, i + 1).filter(Number.isFinite);
    return slice.length === 0 ? NaN : slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

/** p 取 0-100；非有限值被过滤，空集返回 0。 */
export function percentile(values: number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)]!;
}
