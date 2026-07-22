// 把 Narrative 多时间线检索结果转换为 Context Contribution，并保留前端所需的逐线事件。

import type { SessionId, TurnId } from '@ema-agent/ids';
import type { NarrativeTimelineRecall } from '@ema-agent/session';
import type { EmaStreamEvent } from '@ema-agent/turn';
import type { ContextContribution } from '@ema-agent/context';
import { NarrativeClientError } from '@ema-agent/narrative';
import type { ConversationDeps } from './types.js';

export interface NarrativeRecallContext {
  contribution: ContextContribution;
  timelines: NarrativeTimelineRecall[];
}

export async function prepareNarrativeContribution(
  deps: ConversationDeps,
  args: {
    sessionId: string;
    turnId: TurnId;
    userInput: string;
    signal?: AbortSignal;
    emit?: (event: EmaStreamEvent) => void;
  },
): Promise<NarrativeRecallContext | null> {
  const routeResp = await deps.narrative.route(args.userInput, args.signal);
  const routeOrder = Object.keys(routeResp.routes);
  args.emit?.({
    type: 'narrative_route_resolved',
    sessionId: args.sessionId as SessionId,
    turnId: args.turnId,
    timelines: routeOrder,
  });

  if (routeOrder.length === 0) return null;

  const recallParts: Array<[string, string]> = [];
  const recallTimelines: NarrativeTimelineRecall[] = [];
  let failedCount = 0;
  let cancellationError: unknown;

  await Promise.allSettled(
    routeOrder.map(async (timeline) => {
      const query = routeResp.routes[timeline] ?? '';
      try {
        const text = await deps.narrative.queryOne(timeline, query, args.signal);
        args.emit?.({
          type: 'narrative_timeline_complete',
          sessionId: args.sessionId as SessionId,
          turnId: args.turnId,
          timeline,
          charCount: text.length,
          snippet: text.length > 100 ? text.slice(0, 100) + '…' : text,
        });
        // 空结果也要进入 timeline 落盘数据，前端才能区分“检索过但无内容”和“未检索”。
        recallParts.push([timeline, text]);
        recallTimelines.push({ name: timeline, charCount: text.length, text });
      } catch (err) {
        if (isAbortLike(err, args.signal)) {
          cancellationError ??= err;
          return;
        }
        failedCount += 1;
        const failure = err instanceof NarrativeClientError
          ? { code: err.code, message: err.message, retryable: err.retryable }
          : {
              code: 'narrative/unknown' as const,
              message: err instanceof Error ? err.message : String(err),
              retryable: false,
            };
        args.emit?.({
          type: 'narrative_timeline_failed',
          sessionId: args.sessionId as SessionId,
          turnId: args.turnId,
          timeline,
          ...failure,
        });
      }
    }),
  );

  if (cancellationError !== undefined) throw cancellationError;
  if (recallParts.length === 0) {
    if (failedCount > 0) {
      args.emit?.({
        type: 'system_warning',
        level: 'warn',
        message: 'Narrative timelines unavailable - continuing without narrative context',
      });
    }
    return null;
  }

  recallParts.sort(([a], [b]) => routeOrder.indexOf(a) - routeOrder.indexOf(b));
  recallTimelines.sort((a, b) => routeOrder.indexOf(a.name) - routeOrder.indexOf(b.name));

  // 空 timeline 保留在落盘数据中，但不浪费模型上下文。
  const sections = recallParts
    .filter(([, text]) => text.trim().length > 0)
    .map(([timeline, text]) => `## ${timeline}\n${text}`)
    .join('\n\n');

  return {
    contribution: {
      id: 'narrative.recall',
      source: 'narrative',
      placement: 'beforeCurrentTurn',
      message: {
        role: 'user',
        content: `[NARRATIVE CONTEXT - do not quote verbatim; use as background]\n\n${sections}`,
      },
    },
    timelines: recallTimelines,
  };
}

function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return err instanceof Error && err.name === 'AbortError';
}
