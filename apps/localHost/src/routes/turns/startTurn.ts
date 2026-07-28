// 把创建 Turn 的 HTTP 请求转换为统一 TurnExecutor 输入并接入事件发布通道。

import type { Hono } from 'hono';
import type { FileAccessFacade } from '@ema-agent/attachment';
import type { TurnStreamEvent } from '@ema-agent/events';
import {
  asSessionId,
  type SessionId,
} from '@ema-agent/ids';
import type {
  TurnExecutor,
  TurnHandle,
  TurnInputPreparer,
} from '@ema-agent/turn-execution';
import type { TurnSpeechOutput } from '@ema-agent/tts';
import type { SessionStore } from '@ema-agent/session';
import type { TurnEventHub } from '../../sse/event-hub.js';
import type { TurnEventStore } from '../../sse/event-store.js';
import {
  readTurnJsonBody,
  turnBodySchema,
} from './turnSchemas.js';

export interface StartTurnRouteDependencies {
  readonly fileAccess: Pick<FileAccessFacade, 'prepareAttachment'>;
  readonly session: Pick<SessionStore, 'createSession' | 'sessionExists'>;
  readonly executor: Pick<TurnExecutor, 'abort' | 'start'>;
  readonly inputPreparer: Pick<TurnInputPreparer, 'prepare'>;
  readonly speechOutput: Pick<TurnSpeechOutput, 'decorate'>;
}

export function registerStartTurnRoute(
  app: Hono,
  dependencies: StartTurnRouteDependencies,
  eventStore: TurnEventStore,
  eventHub: TurnEventHub,
): void {
  const {
    fileAccess,
    session,
    executor,
    inputPreparer,
    speechOutput,
  } = dependencies;

  app.post('/', async (context) => {
    const parsed = turnBodySchema.safeParse(
      await readTurnJsonBody(context).catch(() => null),
    );
    if (!parsed.success) {
      return context.json({
        error: 'invalid_request',
        details: parsed.error.flatten(),
      }, 400);
    }

    const {
      sessionId,
      trigger,
      executionProfile,
      narrativePolicy,
      userInput,
      contentParts,
      attachments,
      providerId,
      model,
      ttsEnabled,
      thinkingEnabled,
      kbIds,
      kbAssetScopes,
    } = parsed.data;

    // WebView 只提交桌面宿主签发的加密句柄，真实路径和元数据由后端重新读取。
    let attachmentInputs;
    try {
      attachmentInputs = attachments?.map((attachment) =>
        fileAccess.prepareAttachment(attachment));
    } catch (error) {
      return context.json({
        error: 'invalid_attachment',
        message: error instanceof Error ? error.message : String(error),
      }, 400);
    }

    // 数据库刷新后前端可能保留旧 SessionId；此时新建 Session，避免外键错误阻断发送。
    const effectiveSessionId = resolveSessionId(session, sessionId);

    let handle: TurnHandle;
    try {
      handle = executor.start({
        sessionId: effectiveSessionId,
        triggerType: trigger.type,
        executionProfile,
        narrativePolicy,
        userInput: userInput ?? '',
        prepare: (turnContext) => inputPreparer.prepare({
          executionProfile,
          narrativePolicy,
          userInput: userInput ?? '',
          contentParts,
          attachmentInputs,
          providerId,
          model,
          kbIds,
          kbAssetScopes,
          thinking: thinkingEnabled
            ? { enabled: true as const, budgetTokens: 8000 }
            : undefined,
        }, turnContext),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('session_busy')) {
        return context.json({ error: 'session_busy', message }, 409);
      }
      console.error('[turns] turn start failed', error);
      return context.json({ error: 'internal', message }, 500);
    }

    const events: AsyncIterable<TurnStreamEvent> = speechOutput.decorate({
      enabled: ttsEnabled ?? false,
      sessionId: effectiveSessionId,
      turnId: handle.turnId,
      events: handle.events,
    });

    publishTurnEvents(events, handle, eventStore, eventHub, executor);
    return context.json({
      turnId: handle.turnId,
      sessionId: effectiveSessionId,
    });
  });
}

function resolveSessionId(
  session: Pick<SessionStore, 'createSession' | 'sessionExists'>,
  requestedSessionId: string | undefined,
): SessionId {
  if (
    requestedSessionId &&
    session.sessionExists(asSessionId(requestedSessionId))
  ) {
    return asSessionId(requestedSessionId);
  }
  return session.createSession().id;
}

function publishTurnEvents(
  events: AsyncIterable<TurnStreamEvent>,
  handle: TurnHandle,
  eventStore: TurnEventStore,
  eventHub: TurnEventHub,
  executor: Pick<TurnExecutor, 'abort'>,
): void {
  void (async () => {
    for await (const event of events) {
      const result = eventStore.push(handle.turnId, event);
      if (result.status === 'stored') {
        // 重放日志可能对音频脱敏，在线订阅者仍接收当前事件的完整内容。
        eventHub.publish(handle.turnId, {
          cursor: result.published.cursor,
          event,
        });
      } else if (result.status === 'overflow') {
        executor.abort(handle.turnId);
      }
    }
  })().catch((error) => {
    console.error('[turns] event fan-out error', error);
  });
}
