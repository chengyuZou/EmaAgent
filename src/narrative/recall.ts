// 执行 Narrative 路由与多时间线并发召回，并返回可持久化的结构化结果。

import type { SessionId, TurnId } from '@ema-agent/ids';
import type { NarrativeClient } from './client.js';
import { NarrativeClientError } from './errors.js';
import type { NarrativeEvent } from './events.js';

// 为什么不叫 NarrativeSingleRecalResult?
export interface NarrativeRecallTimeline {
  readonly name: string;
  readonly charCount: number;
  readonly text: string;
}

export interface NarrativeRecallResult {
  /** 成功查询的时间线；空文本仍保留，供前端区分“无结果”和“未查询”。 */
  readonly timelines: readonly NarrativeRecallTimeline[];
  /** 只包含非空结果的模型背景文本；没有可注入正文时为 null。 */
  readonly contextText: string | null;
  readonly failedTimelineCount: number;
}

/** Narrative Tool 使用的业务入口；宿主负责绑定本次 Turn 的身份、事件与持久化。 */
export type NarrativeSearchPort = (
  query: string,
  signal: AbortSignal,
) => Promise<NarrativeRecallResult>;

export interface PrepareNarrativeRecallInput {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly userInput: string;
  readonly signal?: AbortSignal;
  readonly emit?: (event: NarrativeEvent) => void;
}

// TODO: 为什么不直接用query()返回的结果？
export async function prepareNarrativeRecall(
  client: NarrativeClient,
  input: PrepareNarrativeRecallInput,
): Promise<NarrativeRecallResult> {
  // TODO: 需不需要每router到一个timeline就发一个narrative_route_resolved事件？现在是一次性发完所有timeline 前端怎么搞的我不知道
  const routeResponse = await client.route(input.userInput, input.signal);
  const routeOrder = Object.keys(routeResponse.routes);
  input.emit?.({
    type: 'narrative_route_resolved',
    sessionId: input.sessionId,
    turnId: input.turnId,
    timelines: routeOrder,
  });

  const recalled = new Map<string, string>();
  let failedTimelineCount = 0;
  let cancellationError: unknown;

  await Promise.allSettled(routeOrder.map(async (timeline) => {
    const query = routeResponse.routes[timeline] ?? '';
    try {
      const text = await client.queryOne(timeline, query, input.signal);
      recalled.set(timeline, text);
      input.emit?.({
        type: 'narrative_timeline_complete',
        sessionId: input.sessionId,
        turnId: input.turnId,
        timeline,
        charCount: text.length,
        snippet: text.length > 100 ? `${text.slice(0, 100)}…` : text,
      });
    } catch (error) {
      if (isAbortLike(error, input.signal)) {
        cancellationError ??= error;
        return;
      }
      failedTimelineCount += 1;
      const failure = error instanceof NarrativeClientError
        ? {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          }
        : {
            code: 'narrative/unknown' as const,
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          };
      input.emit?.({
        type: 'narrative_timeline_failed',
        sessionId: input.sessionId,
        turnId: input.turnId,
        timeline,
        ...failure,
      });
    }
  }));

  if (cancellationError !== undefined) throw cancellationError;

  const timelines = routeOrder.flatMap((name) => {
    const text = recalled.get(name);
    return text === undefined
      ? []
      : [{ name, charCount: text.length, text }];
  });
  const sections = timelines
    .filter((timeline) => timeline.text.trim().length > 0)
    .map((timeline) => `## ${timeline.name}\n${timeline.text}`)
    .join('\n\n');

  return {
    timelines,
    contextText: sections.length > 0 ? sections : null,
    failedTimelineCount,
  };
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return error instanceof Error && error.name === 'AbortError';
}
