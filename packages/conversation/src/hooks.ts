// 注册 Narrative 模式的剧情路由、分时间线召回和部分失败降级 Hook。

import type { HookBus } from '@ema-agent/hook';
import type { EmaStreamEvent, NarrativeTimelineRecall, SessionId, TurnId } from '@ema-agent/contracts';
import type { Message as ModelMessage } from '@ema-agent/llm';
import { NarrativeClientError } from '@ema-agent/narrative-client';
import type { ConversationDeps } from './types.js';

interface NarrativeRecallContext {
  message: ModelMessage;
  timelines: NarrativeTimelineRecall[];
}

/**
 * 把 conversation 层所有 hook 注册到给定总线。
 * 返回反注册函数（测试有用）。
 *
 * 注册的 hook：
 *   - `narrative:recall`（beforeLlm，优先级 5）
 *     只在 mode=narrative 时触发。各 timeline 独立并行查询--每条完成立即
 *     emit `narrative_timeline_complete`，前端不用等慢的 timeline 就能更新
 *     每条 timeline 的状态块。
 */
export function registerConversationHooks(bus: HookBus, deps: ConversationDeps): () => void {
  return bus.register(
    'beforeLlm',
    async (ctx) => {
      if (ctx.payload.mode !== 'narrative') return { kind: 'continue' };

      const userInput = ctx.payload.userInput;
      const signal = ctx.signal;
      if (!userInput) return { kind: 'continue' };

      try {
        const recalled = await recallNarrativeContext(deps, {
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          userInput,
          signal,
          emit: ctx.emit,
        });
        if (!recalled) return { kind: 'continue' };

        // 把 narrative 上下文作为 user message 插到最新 user turn 之前。
        // system prompt 构造和 memory 召回留给它们自己的 hook；ctx.emit 只是当前 turn 的事件出口。
        const msgs = ctx.payload.messages;
        const last = msgs[msgs.length - 1];
        if (!last) return { kind: 'continue' };

        return {
          kind: 'replace',
          payload: {
            ...ctx.payload,
            messages: [...msgs.slice(0, -1), recalled.message, last],
            narrativeRecall: { timelines: recalled.timelines },
          },
        };
      } catch (err) {
        if (isAbortLike(err, signal)) throw err;
        if (err instanceof NarrativeClientError) {
          ctx.emit?.({
            type: 'system_warning',
            level: 'warn',
            message: 'Narrative bridge unavailable - falling back to chat mode',
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
        // 不管 text 空不空都进 recallTimelines -- 落盘要完整(重开能看到所有 timeline,
        // 哪怕检索返回空)。text 空前端展开显示"无内容"提示,不能整个 message 不落盘。
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

  // inject 给 LLM 的只含有内容的 timeline(空 section 对 LLM 无意义)。
  // 落盘的 recallTimelines 保留全部(含空,前端展示"检索了但无内容")。
  const sections = recallParts
    .filter(([, text]) => text.trim().length > 0)
    .map(([timeline, text]) => `## ${timeline}\n${text}`)
    .join('\n\n');

  return {
    message: {
      role: 'user',
      content: `[NARRATIVE CONTEXT - do not quote verbatim; use as background]\n\n${sections}`,
    },
    timelines: recallTimelines,
  };
}

function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return err instanceof Error && err.name === 'AbortError';
}
