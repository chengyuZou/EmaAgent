/**
 * Sentence boundary detection for the document chunking pipeline.
 *
 * Design goals:
 *  - No runtime dependencies (pure string operations)
 *  - Handles English, Chinese, and mixed CJK text
 *  - Avoids false splits on abbreviations and numeric decimals
 *  - Preserves leading/trailing whitespace for accurate token counting
 */

// ── Abbreviation list ─────────────────────────────────────────────────────────

const ABBREVIATIONS = new Set([
  // Titles
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'rev', 'gen', 'sgt', 'cpl',
  'pvt', 'capt', 'lt', 'col', 'maj', 'brig', 'adm',
  // Organizations / misc
  'dept', 'approx', 'inc', 'corp', 'ltd', 'co', 'vs', 'etc',
  'fig', 'est', 'vol', 'avg', 'assn', 'bros', 'no',
  // Month abbreviations
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  // Common academic
  'cf', 'al', 'ibid', 'op', 'cit', 'et', 'eg', 'ie', 'viz',
]);

// ── Core split ────────────────────────────────────────────────────────────────

/**
 * Split text into sentences.
 *
 * Rules (in evaluation order):
 *  1. Double newline always forces a break (paragraph boundary).
 *  2. Chinese/Japanese/Korean terminal punctuation (。！？…) splits immediately.
 *  3. Western terminal punctuation (. ! ?) splits unless:
 *     a. Preceded by a known abbreviation (e.g. "Dr.")
 *     b. Preceded by a single uppercase letter (initials: "J.")
 *     c. Surrounded by digits (decimal: "3.14")
 *     d. Followed by a lowercase letter without space (acronym: "U.S.A.is")
 *     e. Is part of an ellipsis ("...")
 *
 * Returns non-empty trimmed sentences.
 */
export function splitSentences(text: string): string[] {
  if (!text.trim()) return [];

  const sentences: string[] = [];
  let buf = '';

  // First split on hard paragraph breaks (\n\n or more)
  const paragraphs = text.split(/\n{2,}/);

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    buf += (buf ? ' ' : '') + trimmed;
  }

  // Now split the accumulated buffer on sentence boundaries
  // We walk character by character to apply heuristics
  const chars = buf;
  let start = 0;
  let i     = 0;

  const flush = (end: number): void => {
    const s = chars.slice(start, end).trim();
    if (s) sentences.push(s);
    start = end;
  };

  while (i < chars.length) {
    const ch   = chars[i]!;
    const next = chars[i + 1] ?? '';

    // CJK terminal punctuation — always split
    if ('。！？…'.includes(ch) || ('‥'.includes(ch))) {
      // Skip consecutive CJK punctuation (e.g. "！！")
      let j = i + 1;
      while (j < chars.length && '。！？…‥'.includes(chars[j]!)) j++;
      flush(j);
      i = j;
      start = i;
      continue;
    }

    // Ellipsis — skip, do not split
    if (ch === '.' && chars[i + 1] === '.' && chars[i + 2] === '.') {
      i += 3;
      continue;
    }

    // Western terminal punctuation
    if (ch === '.' || ch === '!' || ch === '?') {
      // Closing quote/paren right after punctuation is part of the sentence
      let endOffset = i + 1;
      while (endOffset < chars.length && ')"\'»›'.includes(chars[endOffset]!)) {
        endOffset++;
      }

      // Must be followed by whitespace + uppercase or end-of-string to count
      const afterPunct = chars.slice(endOffset);
      const followsWhitespace = /^\s+[A-Z\p{Lu}]/u.test(afterPunct) || afterPunct.trim() === '';

      if (!followsWhitespace) {
        i++;
        continue;
      }

      if (ch === '.') {
        // Check abbreviation: look back for a word preceding the dot
        const before = chars.slice(start, i);
        const wordMatch = before.match(/(\w+)\s*$/);
        const word = wordMatch?.[1]?.toLowerCase() ?? '';

        // Single uppercase letter (initial): "J."
        if (/^[A-Z]$/.test(wordMatch?.[1] ?? '')) { i++; continue; }

        // Known abbreviation
        if (ABBREVIATIONS.has(word)) { i++; continue; }

        // Decimal number: digit before and digit after (or letter without space)
        const digitBefore = /\d$/.test(before);
        const digitAfter  = /^\s*\d/.test(afterPunct);
        if (digitBefore && digitAfter) { i++; continue; }

        // Acronym pattern: single-char word (U.S.A.)
        if (/^[A-Za-z](\.[A-Za-z])+$/.test(before.trim().split(/\s+/).pop() ?? '')) {
          i++;
          continue;
        }
      }

      flush(endOffset);
      // Skip whitespace after the punctuation
      while (start < chars.length && /\s/.test(chars[start]!)) start++;
      i = start;
      continue;
    }

    i++;
  }

  // Flush remainder
  const remainder = chars.slice(start).trim();
  if (remainder) sentences.push(remainder);

  return sentences.filter(s => s.length > 0);
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

/**
 * Cosine similarity between two float32 vectors.
 * Returns NaN when either vector is zero-length or all zeros.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return Number.NaN;

  let dot  = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot  += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }

  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);

  if (magA === 0 || magB === 0) return Number.NaN;
  return Math.max(-1, Math.min(1, dot / (magA * magB)));
}

/**
 * Rolling average smoothing over a similarity array.
 * Reduces noise from individual sentence embedding variance.
 */
export function smoothSimilarities(sims: number[], windowSize: number): number[] {
  if (windowSize <= 1 || sims.length === 0) return sims;
  const half = Math.floor(windowSize / 2);
  return sims.map((_, i) => {
    const lo   = Math.max(0, i - half);
    const hi   = Math.min(sims.length - 1, i + half);
    let   sum  = 0;
    let   cnt  = 0;
    for (let j = lo; j <= hi; j++) {
      const v = sims[j]!;
      if (!Number.isNaN(v)) { sum += v; cnt++; }
    }
    return cnt > 0 ? sum / cnt : Number.NaN;
  });
}

/**
 * Compute the N-th percentile of an array of numbers (ignoring NaN).
 * Used to derive an adaptive breakpoint threshold from the similarity distribution.
 */
export function percentile(values: number[], p: number): number {
  const finite = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return 0.5;
  const idx = (p / 100) * (finite.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return finite[lo]!;
  const frac = idx - lo;
  return finite[lo]! * (1 - frac) + finite[hi]! * frac;
}
