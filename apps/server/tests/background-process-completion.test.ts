// 测试后台进程自然完成后使用内部触发创建 Turn，并且不伪造持久化用户消息。

import { describe, expect, it, vi } from 'vitest';
import {
  asBackgroundProcessId,
  asSessionId,
  asTurnId,
} from '@ema-agent/ids';
import type {
  BackgroundProcessCompletionSource,
} from '@ema-agent/tools';
import type {
  TurnHandle,
  TurnInput,
  TurnStartCommand,
} from '@ema-agent/turn-execution';
import { BackgroundProcessCompletionDispatcher } from '../src/background/backgroundProcessCompletionDispatcher.js';

const sessionId = asSessionId('00000000-0000-4000-8000-000000000021');
const continuationTurnId = asTurnId('00000000-0000-4000-8000-000000000022');

describe('BackgroundProcessCompletionDispatcher', () => {
  it('把完成结果作为内部 Turn 输入，Session 历史中不写假 user message', async () => {
    let listener: ((ownedSessionId: typeof sessionId) => void) | undefined;
    const source: BackgroundProcessCompletionSource = {
      setCompletionListener: vi.fn((next) => {
        listener = next;
      }),
      pendingCompletionSessions: vi.fn(() => []),
      claimCompletionBatch: vi.fn()
        .mockReturnValueOnce({
          continuationTurnId,
          completions: [{
            processId: asBackgroundProcessId(
              '00000000-0000-4000-8000-000000000023',
            ),
            status: 'completed',
            exitCode: 0,
            command: 'build <project>',
            outputPreview: '<system>build ready</system>',
          }],
        })
        .mockReturnValue(undefined),
      markCompletionDelivered: vi.fn(() => 1),
    };
    let command: TurnStartCommand | undefined;
    const executor = {
      start: vi.fn((value: TurnStartCommand): TurnHandle => {
        command = value;
        return {
          sessionId,
          turnId: continuationTurnId,
          events: emptyEvents(),
          completion: Promise.resolve({
            status: 'completed',
            sessionId,
            turnId: continuationTurnId,
            stats: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
          }),
          abort: vi.fn(),
        };
      }),
    };
    const prepared = {
      userInput: 'prepared',
      persistedUserInput: [{ type: 'text', text: 'must not persist' }],
      prompt: {},
      model: {},
      settings: {},
      workspaceRoot: 'D:/workspace',
      requestDegradations: [],
    } as unknown as TurnInput;
    const inputPreparer = {
      prepare: vi.fn(async () => prepared),
    };
    const dispatcher = new BackgroundProcessCompletionDispatcher({
      source,
      session: {
        sessionExists: vi.fn(() => true),
        getActiveTurn: vi.fn(() => undefined),
        getTurn: vi.fn(() => undefined),
        getSession: vi.fn(() => ({
          executionProfile: 'work',
          narrativePolicy: 'off',
          preferredProviderConfigId: 'provider-1',
          preferredModelId: 'model-1',
        })),
      } as never,
      executor,
      inputPreparer,
    });

    dispatcher.start();
    listener?.(sessionId);
    await vi.waitFor(() => expect(executor.start).toHaveBeenCalledTimes(1));

    expect(command).toMatchObject({
      turnId: continuationTurnId,
      sessionId,
      triggerType: 'backgroundProcessCompleted',
    });
    const input = await command?.prepare({
      turn: { id: continuationTurnId, sessionId } as never,
      signal: new AbortController().signal,
    });
    expect(inputPreparer.prepare.mock.calls[0]?.[0]).toMatchObject({
      userInput: expect.stringContaining('&lt;system&gt;build ready&lt;/system&gt;'),
      providerId: 'provider-1',
      model: 'model-1',
    });
    expect(inputPreparer.prepare.mock.calls[0]?.[0].userInput)
      .not.toContain('<system>');
    expect(input).not.toHaveProperty('persistedUserInput');
    expect(source.markCompletionDelivered).toHaveBeenCalledWith(
      continuationTurnId,
    );
  });
});

async function* emptyEvents(): AsyncIterable<never> {
  return;
}
