import { NarrativeUnavailableError } from '@ema-agent/narrative-client';
import type { MemoryDeps } from '../deps.js';
import type { NarrativeRecallResult } from '../types.js';

/**
 * Narrative recall via Python bridge LightRAG.
 *
 * Two-step protocol: `route` selects timelines and rewrites sub-queries,
 * `query` fetches RAG snippets for each timeline. Only used in narrative mode.
 *
 * Returns `null` (not throws) when the bridge is unavailable or unconfigured —
 * the planner degrades to Layer 0 + Layer 1 in that case.
 */
export async function recallNarrative(
  deps: MemoryDeps,
  userInput: string,
  signal?: AbortSignal,
): Promise<NarrativeRecallResult | null> {
  try {
    const route = await deps.narrative.route(userInput, signal);
    if (Object.keys(route.routes).length === 0) return null;

    const resp = await deps.narrative.query(route.routes, 'hybrid', signal);

    // Preserve the deterministic order produced by /route
    const ordered: Record<string, string> = {};
    for (const timeline of Object.keys(route.routes)) {
      const text = resp.results[timeline];
      if (text && text.trim().length > 0) ordered[timeline] = text;
    }
    if (Object.keys(ordered).length === 0) return null;

    return { sections: ordered };
  } catch (err) {
    if (err instanceof NarrativeUnavailableError) return null;
    throw err;
  }
}
