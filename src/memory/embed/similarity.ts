// ── L2 normalization ─────────────────────────────────────────────────────────

/**
 * Returns the L2-normalized copy of `vec` (unit length).
 * After normalization, cosine similarity reduces to plain dot product, which is
 *   a) ~3× faster than computing two norms + sqrt per pair, and
 *   b) directly compatible with usearch's `ip` (inner-product) metric.
 *
 * Zero-vector input is returned unchanged — caller's responsibility to handle.
 */
export function normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!;
    sumSq += v * v;
  }
  if (sumSq === 0) return vec;
  const inv = 1 / Math.sqrt(sumSq);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! * inv;
  return out;
}

// ── Dot product ──────────────────────────────────────────────────────────────

/**
 * Inner product of two same-length vectors.
 * For L2-normalized vectors this equals cosine similarity in [-1, 1].
 *
 * Mismatched lengths or empty input return 0 — the planner treats this as
 * "no match" and skips the row rather than throwing mid-recall.
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * Kept for backward compatibility / clarity at call sites that haven't been
 * updated yet. Identical to dotProduct() since all stored embeddings are now
 * normalized at pack time.
 */
export const cosineSim = dotProduct;

// ── Buffer ↔ Float32Array packing ────────────────────────────────────────────

/**
 * Normalize-then-pack a JS number[] into a Buffer suitable for the BLOB column.
 *
 * IMPORTANT: every embedding written to the DB goes through this function, so
 * we maintain the invariant "all stored embeddings are unit-length". Recall
 * code can then use dotProduct() and skip per-query normalization too.
 */
export function packEmbedding(vec: number[]): Buffer {
  const f32 = normalize(new Float32Array(vec));
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Read a stored BLOB back as a Float32Array. Copies out so the resulting view
 * is independent of the SQLite-owned buffer (better-sqlite3 may reclaim it).
 * Mismatched byte length → empty Float32Array (similarity-safe).
 */
export function unpackEmbedding(buf: Buffer, dim: number): Float32Array {
  if (buf.byteLength !== dim * 4) return new Float32Array(0);
  const out = new Float32Array(dim);
  out.set(new Float32Array(buf.buffer, buf.byteOffset, dim));
  return out;
}

/**
 * Normalize a raw query embedding (returned by the embed provider before we
 * pack it). Used when computing a per-turn query vector for index search.
 */
export function normalizeQueryVector(vec: number[]): Float32Array {
  return normalize(new Float32Array(vec));
}
