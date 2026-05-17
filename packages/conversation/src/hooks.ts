import type { HookBus } from '@ema-agent/hook';
import type { LlmMessage } from '@ema-agent/llm';
import { NarrativeUnavailableError } from '@ema-agent/narrative-client';
import type { ConversationDeps } from './types.js';

/**
 * Register all conversation-layer hooks onto the provided bus.
 * Returns an unregister function (useful in tests).
 *
 * Registered hooks:
 *   - `narrative:recall` (beforeLlm, priority 5)
 *     Fires only when mode=narrative. Queries each timeline independently and
 *     in parallel — each completion emits `narrative_timeline_complete`
 *     immediately so the frontend can update its per-timeline status block
 *     without waiting for slower timelines.
 */
export function registerConversationHooks(bus: HookBus, deps: ConversationDeps): () => void {
  return bus.register(
    'beforeLlm',
    async (ctx) => {
      if (ctx.meta['mode'] !== 'narrative') return { kind: 'continue' };

      const userInput = ctx.meta['userInput'] as string | undefined;
      const signal    = ctx.meta['signal']    as AbortSignal | undefined;
      if (!userInput) return { kind: 'continue' };

      try {
        const routeResp = await deps.narrative.route(userInput, signal);
        ctx.emit?.({ type: 'narrative_route_resolved', timelines: Object.keys(routeResp.routes) });

        // ── Per-timeline parallel queries ─────────────────────────────────────
        // Each timeline gets its own HTTP request to the bridge so it can emit
        // `narrative_timeline_complete` the moment ITS query returns, without
        // being blocked by slower timelines.
        // Promise.allSettled ensures one bad timeline never kills the others.
        const recallParts: Array<[string, string]> = [];

        await Promise.allSettled(
          Object.entries(routeResp.routes).map(async ([timeline, query]) => {
            try {
              const text = await deps.narrative.queryOne(timeline, query, signal);
              ctx.emit?.({
                type: 'narrative_timeline_complete',
                timeline,
                charCount: text.length,
                snippet: text.length > 100 ? text.slice(0, 100) + '…' : text,
              });
              if (text.trim().length > 0) recallParts.push([timeline, text]);
            } catch (err) {
              if (err instanceof NarrativeUnavailableError) throw err; // re-throw to outer catch
              ctx.emit?.({
                type: 'system_warning',
                level: 'warn',
                message: `Timeline ${timeline} recall failed — excluded from context`,
              });
            }
          }),
        );

        if (recallParts.length === 0) return { kind: 'continue' };

        const sections = recallParts
          .map(([timeline, text]) => `## ${timeline}\n${text}`)
          .join('\n\n');

        ctx.emit?.({
          type: 'recall_evidence',
          sources: recallParts.map(([t]) => t),
          itemCount: recallParts.length,
        });

        // Inject recall context as a user message immediately before the latest
        // user turn — doesn't touch system prefix, preserves prompt-cache reuse.
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
