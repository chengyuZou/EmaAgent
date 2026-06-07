import type { HookBus } from '@ema-agent/hook';
import type { EmaStreamEvent, SessionId } from '@ema-agent/contracts';
import type { LlmMessage } from '@ema-agent/contracts';
import { NarrativeUnavailableError } from '@ema-agent/narrative-client';
import type { ConversationDeps } from './types.js';

interface NarrativeRecallContext {
  message: LlmMessage;
}

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
        const recalled = await recallNarrativeContext(deps, {
          sessionId: ctx.sessionId,
          userInput,
          signal,
          emit: ctx.emit,
        });
        if (!recalled) return { kind: 'continue' };

        // Inject narrative context as a user message immediately before the latest
        // user turn. This leaves system prompt construction and memory recall to
        // their own hooks; ctx.emit is only the current turn's event outlet.
        const msgs = ctx.payload.messages;
        const last = msgs[msgs.length - 1];
        if (!last) return { kind: 'continue' };

        return {
          kind: 'replace',
          payload: {
            ...ctx.payload,
            messages: [...msgs.slice(0, -1), recalled.message, last],
          },
        };
      } catch (err) {
        if (isAbortLike(err, signal)) throw err;
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

async function recallNarrativeContext(
  deps: ConversationDeps,
  args: {
    sessionId: string;
    userInput: string;
    signal?: AbortSignal;
    emit?: (event: EmaStreamEvent) => void;
  },
): Promise<NarrativeRecallContext | null> {
  const routeResp = await deps.narrative.route(args.userInput, args.signal);
  const routeOrder = Object.keys(routeResp.routes);
  args.emit?.({ type: 'narrative_route_resolved', sessionId: args.sessionId as SessionId, timelines: routeOrder });

  if (routeOrder.length === 0) return null;

  const recallParts: Array<[string, string]> = [];
  let fatalError: unknown;

  await Promise.allSettled(
    routeOrder.map(async (timeline) => {
      const query = routeResp.routes[timeline] ?? '';
      try {
        const text = await deps.narrative.queryOne(timeline, query, args.signal);
        args.emit?.({
          type: 'narrative_timeline_complete',
          sessionId: args.sessionId as SessionId,
          timeline,
          charCount: text.length,
          snippet: text.length > 100 ? text.slice(0, 100) + '…' : text,
        });
        if (text.trim().length > 0) recallParts.push([timeline, text]);
      } catch (err) {
        if (isAbortLike(err, args.signal) || err instanceof NarrativeUnavailableError) {
          fatalError ??= err;
          return;
        }
        args.emit?.({
          type: 'system_warning',
          level: 'warn',
          message: `Timeline ${timeline} recall failed — excluded from context`,
        });
      }
    }),
  );

  if (fatalError !== undefined) throw fatalError;
  if (recallParts.length === 0) return null;

  recallParts.sort(([a], [b]) => routeOrder.indexOf(a) - routeOrder.indexOf(b));

  const sections = recallParts
    .map(([timeline, text]) => `## ${timeline}\n${text}`)
    .join('\n\n');

  return {
    message: {
      role: 'user',
      content: `[NARRATIVE CONTEXT — do not quote verbatim; use as background]\n\n${sections}`,
    },
  };
}

function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return err instanceof Error && err.name === 'AbortError';
}
