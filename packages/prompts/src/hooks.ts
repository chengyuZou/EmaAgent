import type { HookBus } from '@ema-agent/hook';
import type { CharacterCardStore } from '@ema-agent/character-card';
import { buildSystemPrompt } from './build.js';

// ── Hook deps ────────────────────────────────────────────────────────────────

export interface PromptsHooksDeps {
  card: CharacterCardStore;
}

// ── Hook registration ────────────────────────────────────────────────────────

/**
 * Register the `prompts:buildSystem` hook on the provided bus.
 *
 *   beforeLlm (priority 10): prepends a system-role message at messages[0]
 *   built from the currently-active character card + the turn's mode block.
 *
 * Priority 10 places this BEFORE memory's beforeLlm hook (priority 20), so
 * by the time memory's compaction + recall runs, the system prompt is already
 * the first element of payload.messages.
 *
 * Returns an unregister function for tests.
 */
export function registerPromptsHooks(
  bus: HookBus,
  deps: PromptsHooksDeps,
): () => void {
  return bus.register(
    'beforeLlm',
    async (ctx) => {
      const card    = deps.card.current();
      const mode = ctx.payload.mode;
      const workspaceRoot = ctx.payload.workspaceRoot;

      const systemPrompt = buildSystemPrompt(card, mode, { workspaceRoot });

      // Prepend the system message if the messages array doesn't already
      // start with one. (Defensive — callers that pre-seed messages with a
      // system row are still supported.)
      const messages = ctx.payload.messages;
      const stableSystem = {
        role: 'system' as const,
        content: systemPrompt,
        cacheBreakpoint: true as const,
      };
      const next = messages[0]?.role === 'system'
        ? [stableSystem, ...messages.slice(1)]
        : [stableSystem, ...messages];

      return {
        kind: 'replace',
        payload: {
          ...ctx.payload,
          messages: next,
        },
      };
    },
    { name: 'prompts:buildSystem', priority: 10 },
  );
}
