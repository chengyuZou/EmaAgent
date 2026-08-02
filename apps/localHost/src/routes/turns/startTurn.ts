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
  TurnOutcome,
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

    const effectiveSessionId = resolveSessionId(session, sessionId);
    if (!effectiveSessionId) {
      return context.json({ error: 'session_not_found' }, 404);
    }

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

    // 先登记空重放槽再返回身份，避免客户端立即订阅时首事件尚未到达而误报不存在。
    eventStore.open(handle.turnId);
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
): SessionId | undefined {
  if (!requestedSessionId) return session.createSession().id;
  const sessionId = asSessionId(requestedSessionId);
  return session.sessionExists(sessionId) ? sessionId : undefined;
}

function publishTurnEvents(
  events: AsyncIterable<TurnStreamEvent>,
  handle: TurnHandle,
  eventStore: TurnEventStore,
  eventHub: TurnEventHub,
  executor: Pick<TurnExecutor, 'abort'>,
): void {
  void (async () => {
    try {
      for await (const event of events) {
        const result = publishEvent(eventStore, eventHub, handle.turnId, event);
        if (result === 'overflow') executor.abort(handle.turnId);
      }
    } catch (error) {
      console.error('[turns] event decoration or fan-out failed', error);
      executor.abort(handle.turnId);
    } finally {
      await publishMissingTerminal(handle, eventStore, eventHub);
    }
  })().catch((error) => {
    // completion 本身失败且终态也无法写入时，只能记录传输级故障。
    console.error('[turns] terminal event publication failed', error);
  });
}

function publishEvent(
  eventStore: TurnEventStore,
  eventHub: TurnEventHub,
  turnId: TurnHandle['turnId'],
  event: TurnStreamEvent,
): 'stored' | 'overflow' | 'closed' {
  const result = eventStore.push(turnId, event);
  if (result.status !== 'stored') return result.status;

  // 重放日志可能对音频脱敏，在线订阅者仍接收当前事件的完整内容。
  eventHub.publish(turnId, {
    cursor: result.published.cursor,
    event,
  });
  return 'stored';
}

/**
 * 输出装饰器或事件分发异常不能让客户端永久等待。根执行的 completion 是终态
 * 事实源；事件流未送达终态时，只在传输层补发同一结果，不重新提交数据库。
 */
async function publishMissingTerminal(
  handle: TurnHandle,
  eventStore: TurnEventStore,
  eventHub: TurnEventHub,
): Promise<void> {
  if (eventStore.isDone(handle.turnId)) return;

  let event: TurnStreamEvent;
  try {
    event = terminalEvent(await handle.completion);
  } catch (error) {
    event = {
      type: 'turn_failed',
      sessionId: handle.sessionId,
      turnId: handle.turnId,
      code: 'turn/execution_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  publishEvent(eventStore, eventHub, handle.turnId, event);
}

function terminalEvent(outcome: TurnOutcome): TurnStreamEvent {
  switch (outcome.status) {
    case 'completed':
      return {
        type: 'turn_completed',
        sessionId: outcome.sessionId,
        turnId: outcome.turnId,
        stats: outcome.stats,
      };
    case 'failed':
      return {
        type: 'turn_failed',
        sessionId: outcome.sessionId,
        turnId: outcome.turnId,
        code: outcome.code,
        message: outcome.message,
      };
    case 'aborted':
      return {
        type: 'turn_aborted',
        sessionId: outcome.sessionId,
        turnId: outcome.turnId,
        reason: outcome.reason,
      };
  }
}
