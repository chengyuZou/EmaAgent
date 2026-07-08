import type { HookBus } from '@ema-agent/hook';
import type { EmaStreamEvent, NarrativeTimelineRecall, SessionId } from '@ema-agent/contracts';
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
          meta: ctx.meta,  // 写 narrativeRecall,engine trigger 后落盘用
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
    /** HookContext.shared bag -- 写 narrativeRecall 让 engine 落盘 */
    meta?: Record<string, unknown>;
  },
): Promise<NarrativeRecallContext | null> {
  const routeResp = await deps.narrative.route(args.userInput, args.signal);
  const routeOrder = Object.keys(routeResp.routes);
  args.emit?.({ type: 'narrative_route_resolved', sessionId: args.sessionId as SessionId, timelines: routeOrder });

  if (routeOrder.length === 0) return null;

  const recallParts: Array<[string, string]> = [];
  const recallTimelines: NarrativeTimelineRecall[] = [];
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
        // 不管 text 空不空都进 recallTimelines -- 落盘要完整(重开能看到所有 timeline,
        // 哪怕检索返回空)。text 空前端展开显示"无内容"提示,不能整个 message 不落盘。
        recallParts.push([timeline, text]);
        recallTimelines.push({ name: timeline, charCount: text.length, text });
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

  // 写 shared bag:engine 在 trigger 返回后读 meta.narrativeRecall 落盘成
  // kind='narrative_context' message(既回灌 LLM 又前端显示),一份内容不拆。
  if (args.meta && recallTimelines.length > 0) {
    args.meta['narrativeRecall'] = { timelines: recallTimelines };
  }

  recallParts.sort(([a], [b]) => routeOrder.indexOf(a) - routeOrder.indexOf(b));

  // inject 给 LLM 的只含有内容的 timeline(空 section 对 LLM 无意义)。
  // 落盘的 recallTimelines 保留全部(含空,前端展示"检索了但无内容")。
  const sections = recallParts
    .filter(([, text]) => text.trim().length > 0)
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
