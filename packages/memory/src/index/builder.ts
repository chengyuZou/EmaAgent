import type { MemoryNodesRepo, MemoryItemsRepo } from '@ema-agent/storage';
import type { VectorIndex } from './vector-index.js';
import { unpackEmbedding } from '../embed/similarity.js';

// ── Bulk loaders ─────────────────────────────────────────────────────────────

/**
 * Load every node with a compatible embedding into the provided index.
 * "Compatible" = same provider id as the active embed provider AND matching
 * dimension. Incompatible rows are skipped — they'll be re-embedded by the
 * background `embedding_refresh` task.
 *
 * Returns the number of vectors actually added.
 */
export function rebuildNodesIndex(
  index: VectorIndex,
  repo:  MemoryNodesRepo,
  providerId: string,
): number {
  const rows = repo.listEmbeddable(providerId);
  let added = 0;
  for (const row of rows) {
    if (!row.embedding) continue;
    if (row.embedding_dim !== index.dim) continue;
    const vec = unpackEmbedding(row.embedding, index.dim);
    if (vec.length === 0) continue;
    index.add(row.id, vec);
    added++;
  }
  return added;
}

export function rebuildItemsIndex(
  index: VectorIndex,
  repo:  MemoryItemsRepo,
  providerId: string,
): number {
  const rows = repo.listEmbeddable(providerId);
  let added = 0;
  for (const row of rows) {
    if (!row.embedding) continue;
    if (row.embedding_dim !== index.dim) continue;
    const vec = unpackEmbedding(row.embedding, index.dim);
    if (vec.length === 0) continue;
    index.add(row.id, vec);
    added++;
  }
  return added;
}
