import { registerPromptsHooks }      from '@ema-agent/prompts';
import { registerConversationHooks } from '@ema-agent/conversation';
import { registerMemoryHooks }       from '@ema-agent/memory';
import { ModelCatalog }              from '@ema-agent/llm';
import type { AppBindings } from './bindings.js';

// Shared catalog instance — holds static model definitions and any runtime-
// fetched entries. Created once per process; hot-reload upserts into it.
const modelCatalog = new ModelCatalog();

// ── Aggregated hook registration ─────────────────────────────────────────────

/**
 * Register every package's hooks on the shared HookBus.
 *
 * Order matters because hooks run in ascending priority order:
 *
 *   priority 5   conversation:narrative (narrative-mode RAG recall)
 *   priority 10  prompts:buildSystem    (build + prepend system message)
 *   priority 20  memory:beforeLlm       (compaction + recall injection)
 *   priority 50  memory:onTurnEnd       (extract pending fragments)
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

  // ── memory: compaction + recall + post-turn extraction ────────────────────
  offs.push(registerMemoryHooks(bindings.hooks, {
    planner:      bindings.memory,
    session:      bindings.session,
    llm:          bindings.llm,
    modelCatalog,
    // Three-tier context window resolution (highest priority first):
    //   1. User-configured value on the provider itself  (Ollama, custom OpenRouter, etc.)
    //   2. Static ModelCatalog entry for known model names
    //   3. Return 0 → hooks.ts falls back to defaultContextWindow (128K)
    getContextWindow: (providerId, model) => {
      // Tier 1: explicit user config
      const configured = bindings.llm.configuredContextWindowFor(providerId);
      if (configured) return configured;
      // Tier 2: catalog lookup
      const protocol = bindings.llm.getProtocol(providerId);
      if (!protocol) return 0;
      return modelCatalog.get(protocol, model)?.contextWindow ?? 0;
    },
    // Agent sessions: supply the 20 most recently touched files so the post-compact
    // restore step can re-inject their content without a redundant LLM round-trip.
    // Conversation sessions have no file state — the store simply returns [].
    recentFiles: (sessionId) =>
      bindings.getContextStores(sessionId).fileStateStore.recentEntries(20),
  }));

  // ── skill: system prompt injection ───────────────────────────────────────
  bindings.skillRunner.start();
  offs.push(() => bindings.skillRunner.stop());

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* tolerate idempotent unregister */ }
    }
  };
}
