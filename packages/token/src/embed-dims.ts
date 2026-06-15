import table from './embed-dims.json' with { type: 'json' };

// ── Model → vector dimension fallback lookup ──────────────────────────────────
//
// Priority of sources (highest first):
//   1. provider_embed_models.dim  (stored at enable time — from live API or user entry)
//   2. this table                 ← here
//   3. user manual entry          (last resort)
//
// Pure data + pure functions, zero deps.

const EMBED_DIMS = table as Record<string, number>;

/**
 * Look up a model's vector dimension.
 *   - exact id match wins (case-insensitive)
 *   - else the LONGEST matching prefix
 *   - else undefined (caller falls back to user input)
 */
export function lookupEmbedDim(modelId: string): number | undefined {
  const id = modelId.trim().toLowerCase();
  if (!id) return undefined;

  const exact = EMBED_DIMS[id];
  if (exact !== undefined) return exact;

  let bestKey = '';
  for (const key of Object.keys(EMBED_DIMS)) {
    if (id.startsWith(key) && key.length > bestKey.length) bestKey = key;
  }
  return bestKey ? EMBED_DIMS[bestKey] : undefined;
}

/** All known embed model ids (for manual-add autocomplete). */
export function knownEmbedModelIds(): string[] {
  return Object.keys(EMBED_DIMS);
}

/** Autocomplete candidates for the embed model picker. */
export function suggestEmbedModels(query: string, limit = 8): Array<{ id: string; dim: number }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const keys = Object.keys(EMBED_DIMS);
  const prefix  = keys.filter((k) => k.startsWith(q));
  const contains = keys.filter((k) => !k.startsWith(q) && k.includes(q));
  return [...prefix, ...contains]
    .slice(0, limit)
    .map((id) => ({ id, dim: EMBED_DIMS[id]! }));
}
