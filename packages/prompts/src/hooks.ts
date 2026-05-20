import type { HookBus } from '@ema-agent/hook';
import type { CharacterCardStore } from '@ema-agent/character-card';
import type { TurnMode, AgentSubMode } from '@ema-agent/contracts';
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
      const mode    = (ctx.meta['mode']    as TurnMode | undefined)     ?? 'chat';
      const subMode =  ctx.meta['subMode'] as AgentSubMode | undefined;

      // workspaceRoots are intentionally omitted at hook level — agent mode's
      // engine passes them via meta when they're available. For chat / narrative
      // they're irrelevant.
      const workspaceRoots = ctx.meta['workspaceRoots'] as string[] | undefined;

      const systemPrompt = buildSystemPrompt(card, mode, {
        agentSubMode: subMode,
        workspaceRoots,
      });

      // Prepend the system message if the messages array doesn't already
      // start with one. (Defensive — callers that pre-seed messages with a
      // system row are still supported.)
      const messages = ctx.payload.messages;
      const next = messages[0]?.role === 'system'
        ? [{ role: 'system' as const, content: systemPrompt }, ...messages.slice(1)]
        : [{ role: 'system' as const, content: systemPrompt }, ...messages];

      return {
        kind: 'replace',
        payload: {
          systemPrompt,
          messages: next,
        },
      };
    },
    { name: 'prompts:buildSystem', priority: 10 },
  );
}
