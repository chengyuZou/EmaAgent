import { registerPromptsHooks }      from '@ema-agent/prompts';
import { registerConversationHooks } from '@ema-agent/conversation';
import type { AppBindings } from './bindings.js';

// ── Aggregated hook registration ─────────────────────────────────────────────

/**
 * Register every package's hooks on the shared HookBus.
 *
 * Order matters because hooks run in ascending priority order:
 *
 *   priority 5   conversation:narrative (narrative-mode RAG recall)
 *   priority 10  prompts:buildSystem    (build + prepend system message)
 *   priority 20  memory:beforeLlm       (compaction + recall injection)  [5B]
 *
 * Each register function returns its own unregister; the aggregate returns a
 * single function that unregisters ALL of them — handy for tests and hot
 * reload during dev.
 */
export function registerAllHooks(bindings: AppBindings): () => void {
  const offs: Array<() => void> = [];

  // ── prompts: system prompt builder ────────────────────────────────────────
  offs.push(registerPromptsHooks(bindings.hooks, { card: bindings.card }));

  // ── conversation: narrative mode RAG recall ───────────────────────────────
  offs.push(registerConversationHooks(bindings.hooks, {
    session:       bindings.session,
    hooks:         bindings.hooks,
    llm:           bindings.llm,
    emotion:       bindings.emotion,
    narrative:     bindings.narrative,
    modelBindings: bindings.modelBindings,
  }));

  // ── memory (5B) ───────────────────────────────────────────────────────────
  // registerMemoryHooks(bindings.hooks, { planner: bindings.memory, ... });

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* tolerate idempotent unregister */ }
    }
  };
}
