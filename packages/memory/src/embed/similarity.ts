// ── Cosine similarity ────────────────────────────────────────────────────────

/**
 * Cosine similarity between two same-dimension vectors.
 * Returns a number in [-1, 1]; 1 = identical direction, 0 = orthogonal.
 *
 * Mismatched lengths or zero-norm vectors return 0 — the planner treats this
 * as "no match" and skips the row, rather than throwing mid-recall.
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot   += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Buffer ↔ Float32Array packing ─────────────────────────────────────────────

/**
 * Pack a JS number[] (provider response) into a Buffer suitable for the BLOB
 * column. The reverse `unpackEmbedding` reads it back as a Float32Array view.
 */
export function packEmbedding(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Read a stored BLOB back as a Float32Array view.
 * `dim` is required because better-sqlite3 returns Buffers without dimension info.
 * Mismatched byte length → returns an empty Float32Array (similarity-safe).
 */
export function unpackEmbedding(buf: Buffer, dim: number): Float32Array {
  if (buf.byteLength !== dim * 4) return new Float32Array(0);
  // Copy out so the view is independent of the underlying SQLite-owned buffer
  const out = new Float32Array(dim);
  out.set(new Float32Array(buf.buffer, buf.byteOffset, dim));
  return out;
}
