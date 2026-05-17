import type { HookBus } from '@ema-agent/hook';
import type { LlmMessage } from '@ema-agent/llm';
import { NarrativeUnavailableError } from '@ema-agent/narrative-client';
import type { ConversationDeps } from './types.js';

/**
 * Register all conversation-layer hooks onto the provided bus.
 *
 * Call once during app/CLI wiring. Returns an unregister function for cleanup
 * (useful in tests).
 *
 * Registered hooks:
 *   - `narrative:recall` (beforeLlm, priority 5) — runs only when mode=narrative;
 *     calls the bridge to route + query RAG, injects recall context into messages,
 *     and emits narrative_route_resolved / recall_evidence SSE events.
 *     Falls back gracefully when the bridge is unavailable.
 */
export function registerConversationHooks(bus: HookBus, deps: ConversationDeps): () => void {
  return bus.register(
    'beforeLlm',
    async (ctx) => {
      if (ctx.meta['mode'] !== 'narrative') return { kind: 'continue' };

      const userInput = ctx.meta['userInput'] as string | undefined;
      // Bug #1: signal from engine meta lets us abort the HTTP call immediately
      // when the user clicks Stop, instead of waiting up to 60 s for timeout.
      const signal = ctx.meta['signal'] as AbortSignal | undefined;

      if (!userInput) return { kind: 'continue' };

      try {
        const routeResp = await deps.narrative.route(userInput, signal);
        ctx.emit?.({ type: 'narrative_route_resolved', routes: routeResp.routes });

        const queryResp = await deps.narrative.query(routeResp.routes, 'hybrid', signal);
        const sections = Object.entries(queryResp.results)
          .filter(([, text]) => text.trim().length > 0)
          .map(([timeline, text]) => `## ${timeline}\n${text}`)
          .join('\n\n');

        if (sections.length === 0) return { kind: 'continue' };

        ctx.emit?.({
          type: 'recall_evidence',
          sources: Object.keys(queryResp.results),
          itemCount: Object.keys(queryResp.results).length,
        });

        // Inject recall context as a user message immediately before the latest
        // user turn so it stays in-context but doesn't pollute the system prefix
        // (preserves prompt-cache reuse).
        const msgs = ctx.payload.messages;
        const last = msgs[msgs.length - 1]!;
        const recallMsg: LlmMessage = {
          role: 'user',
          content: `[NARRATIVE CONTEXT — do not quote verbatim; use as background]\n\n${sections}`,
        };

        return {
          kind: 'replace',
          payload: {
            ...ctx.payload,
            messages: [...msgs.slice(0, -1), recallMsg, last],
          },
        };
      } catch (err) {
        if (err instanceof NarrativeUnavailableError) {
          ctx.emit?.({
            type: 'system_warning',
            level: 'warn',
            message: 'Narrative bridge unavailable — falling back to chat mode',
          });
          return { kind: 'continue' };
        }
        throw err;
      }
    },
    { name: 'narrative:recall', priority: 5 },
  );
}
