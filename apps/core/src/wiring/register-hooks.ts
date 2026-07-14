import { registerPromptsHooks }      from '@ema-agent/prompts';
import { registerConversationHooks } from '@ema-agent/conversation';
import { registerMemoryHooks }       from '@ema-agent/memory';
import type { AppBindings } from './bindings.js';

// ── Aggregated hook registration ─────────────────────────────────────────────

/**
 * Register every package's hooks on the shared HookBus.
 *
 * beforeLlm hooks (run in priority order before each LLM call):
 *   priority  5   narrative:recall       (RAG recall for narrative mode)
 *   priority 10   prompts:buildSystem    (build + prepend system message)
 *   priority 20   memory:beforeLlm       (first-call recall injection)
 *   priority 50   skill:inject-prompts   (append active skill bodies to system)
 *
 * onTurnEnd hooks (run after the turn stream closes):
 *   priority 50   memory:onTurnEnd       (append pending fragments, maybe enqueue extraction)
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
    session:   bindings.session,
    hooks:     bindings.hooks,
    llm:       bindings.llm,
    emotion:   bindings.emotion,
    narrative: bindings.narrative,
  }));

  // ── memory: recall + post-turn extraction ─────────────────────────────────
  offs.push(registerMemoryHooks(bindings.hooks, {
    planner:      bindings.memory,
    session:      bindings.session,
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
