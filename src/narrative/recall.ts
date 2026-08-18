// 把一次原子 Narrative Recall 投影为模型上下文和前端生命周期事件。
import type { NarrativeClient } from './client.js';
import { NarrativeClientError } from './errors.js';
import type { NarrativeEvent } from './events.js';
import type { NarrativeTimelineFailure } from './types.js';

export interface NarrativeRecallTimeline {
  readonly name: string;
  readonly charCount: number;
  readonly text: string;
}

export interface NarrativeRecallResult {
  readonly generationId: string;
  /** 成功查询的时间线；空文本仍保留，供 UI 区分无结果与未查询。 */
  readonly timelines: readonly NarrativeRecallTimeline[];
  readonly failures: readonly NarrativeTimelineFailure[];
  /** 只包含非空结果的模型背景文本；没有可注入正文时为 null。 */
  readonly contextText: string | null;
}

/** Narrative Tool 使用的业务入口；宿主负责绑定本次 Turn 的身份与事件。 */
export type NarrativeSearch = (
  query: string,
  signal: AbortSignal,
) => Promise<NarrativeRecallResult>;

export interface PrepareNarrativeRecallInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userInput: string;
  readonly signal?: AbortSignal;
  readonly emit?: (event: NarrativeEvent) => void;
}

export async function prepareNarrativeRecall(
  client: NarrativeClient,
  input: PrepareNarrativeRecallInput,
): Promise<NarrativeRecallResult> {
  input.emit?.({
    type: 'narrative_recall_started',
    sessionId: input.sessionId,
    turnId: input.turnId,
  });

  try {
    const response = await client.recall(
      { query: input.userInput },
      input.signal,
    );
    const timelineOrder = Object.keys(response.routes);
    const timelines = timelineOrder.flatMap((name) => {
      const text = response.results[name];
      return text === undefined
        ? []
        : [{ name, charCount: text.length, text }];
    });
    const contextText = timelines
      .filter((timeline) => timeline.text.trim().length > 0)
      .map((timeline) => `## ${timeline.name}\n${timeline.text}`)
      .join('\n\n');

    input.emit?.({
      type: 'narrative_recall_completed',
      sessionId: input.sessionId,
      turnId: input.turnId,
      generationId: response.generationId,
      timelineOrder,
      timelines: timelines.map((timeline) => ({
        name: timeline.name,
        charCount: timeline.charCount,
        snippet: summarizeTimeline(timeline.text),
      })),
      failures: response.failures,
    });

    return {
      generationId: response.generationId,
      timelines,
      failures: response.failures,
      contextText: contextText.length > 0 ? contextText : null,
    };
  } catch (error) {
    if (isAbortLike(error, input.signal)) throw error;
    const failure = error instanceof NarrativeClientError
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : {
          code: 'narrative/unknown' as const,
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        };
    input.emit?.({
      type: 'narrative_recall_failed',
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...failure,
    });
    throw error;
  }
}

function summarizeTimeline(text: string): string {
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return error instanceof Error && error.name === 'AbortError';
}
