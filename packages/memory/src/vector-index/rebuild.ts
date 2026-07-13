import type {
  MemoryEmbeddingPageCursor,
  MemoryItemsRepo,
  MemoryNodesRepo,
} from '@ema-agent/storage';
import type { VectorIndex } from './vector-index.js';
import { unpackEmbedding } from '../embed/similarity.js';

// ── Bulk loaders ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 500;

/**
 * Load every node with a compatible embedding into the provided index.
 * "Compatible" = same model (defines the vector space) AND matching dim
 * (guards against malformed data). Incompatible rows are skipped —
 * they'll be re-embedded by the background `embedding_refresh` task.
 *
 * Uses cursor pagination (updated_at, id) to avoid loading all rows into memory
 * at once — safe at any scale.
 *
 * Returns the number of vectors actually added.
 */
export function rebuildNodesIndex(
  index: VectorIndex,
  repo:  MemoryNodesRepo,
  model: string,
): number {
  let after: MemoryEmbeddingPageCursor | undefined;
  let added = 0;
  for (;;) {
    const rows = repo.listEmbeddablePage(model, after, PAGE_SIZE);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!row.embedding)                   continue;
      if (row.embedding_dim !== index.dim)  continue;
      const vec = unpackEmbedding(row.embedding, index.dim);
      if (vec.length === 0) continue;
      index.add(row.id, vec);
      added++;
    }
    const last = rows.at(-1)!;
    after = { updatedAt: last.updated_at, id: last.id };
    if (rows.length < PAGE_SIZE) break;
  }
  return added;
}

export function rebuildItemsIndex(
  index: VectorIndex,
  repo:  MemoryItemsRepo,
  model: string,
): number {
  let after: MemoryEmbeddingPageCursor | undefined;
  let added = 0;
  for (;;) {
    const rows = repo.listEmbeddablePage(model, after, PAGE_SIZE);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!row.embedding)                   continue;
      if (row.embedding_dim !== index.dim)  continue;
      const vec = unpackEmbedding(row.embedding, index.dim);
      if (vec.length === 0) continue;
      index.add(row.id, vec);
      added++;
    }
    const last = rows.at(-1)!;
    after = { updatedAt: last.updated_at, id: last.id };
    if (rows.length < PAGE_SIZE) break;
  }
  return added;
}
