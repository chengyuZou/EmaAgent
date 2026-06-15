import table from './context-windows.json' with { type: 'json' };

// ── Model → context window (token) fallback lookup ────────────────────────────
//
// The context window is a HARD requirement for memory budgeting — without it
// the planner can't size the prompt and the turn overflows → provider 413.
// Priority of sources (highest first):
//   1. provider's /v1/models response (if it carries context length)
//   2. this table          ← here
//   3. user manual entry    (last resort when the table misses)
//
// Pure data + pure functions, zero deps — JSON imports natively in both the
// Node sidecar and the Vite frontend.

const CONTEXT_WINDOWS = table as Record<string, number>;

/** All known model ids (for the manual-add autocomplete prefix match). */
export function knownModelIds(): string[] {
  return Object.keys(CONTEXT_WINDOWS);
}

/**
 * Look up a model's context window.
 *   - exact id match wins
 *   - else the LONGEST matching prefix (so "deepseek-chat-0528" → "deepseek-chat")
 *   - else undefined (caller falls back to user input)
 */
export function lookupContextWindow(modelId: string): number | undefined {
  const id = modelId.trim().toLowerCase();
  if (!id) return undefined;

  const exact = CONTEXT_WINDOWS[id];
  if (exact !== undefined) return exact;

  let bestKey = '';
  for (const key of Object.keys(CONTEXT_WINDOWS)) {
    if (id.startsWith(key) && key.length > bestKey.length) bestKey = key;
  }
  return bestKey ? CONTEXT_WINDOWS[bestKey] : undefined;
}

/**
 * Autocomplete candidates for the manual-add model input. Returns table keys
 * whose id contains the query (prefix matches ranked first), each with its
 * context window so the UI can preview + auto-fill on selection.
 */
export function suggestModels(query: string, limit = 8): Array<{ id: string; contextWindow: number }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const keys = Object.keys(CONTEXT_WINDOWS);
  const prefix = keys.filter((k) => k.startsWith(q));
  const contains = keys.filter((k) => !k.startsWith(q) && k.includes(q));
  return [...prefix, ...contains]
    .slice(0, limit)
    .map((id) => ({ id, contextWindow: CONTEXT_WINDOWS[id]! }));
}
