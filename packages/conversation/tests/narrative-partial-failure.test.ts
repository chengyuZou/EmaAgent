// 测试 Narrative 多时间线召回保留成功分区，并结构化报告失败分区。

import { describe, expect, it } from 'vitest';
import type { EmaStreamEvent, SessionId, TurnId } from '@ema-agent/contracts';
import { HookBus } from '@ema-agent/hook';
import { NarrativeRequestError } from '@ema-agent/narrative-client';
import { registerConversationHooks } from '../src/hooks.js';

const sessionId = 'session-narrative' as SessionId;
const turnId = 'turn-narrative' as TurnId;

describe('Narrative 部分失败', () => {
  it('一条 timeline 失败时仍向 LLM 注入其他成功结果', async () => {
    const hooks = new HookBus();
    const events: EmaStreamEvent[] = [];
    registerConversationHooks(hooks, {
      session: {} as never,
      narrative: {
        route: async () => ({
          routes: {
            '1st_Loop': 'first',
            '2nd_Loop': 'second',
            '3rd_Loop': 'third',
          },
        }),
        queryOne: async (timeline: string) => {
          if (timeline === '2nd_Loop') {
            throw new NarrativeRequestError('timeline failed', {
              code: 'narrative/http_error',
              retryable: true,
              status: 500,
            });
          }
          return `${timeline} recalled text`;
        },
      } as never,
    });

    const result = await hooks.trigger('beforeLlm', {
      sessionId,
      turnId,
      payload: {
        iteration: 1,
        llmCallId: 'llm-call-narrative' as never,
        messages: [{ role: 'user', content: '发生了什么？' }],
        mode: 'narrative',
        userInput: '发生了什么？',
        providerId: 'provider',
        model: 'model',
      },
      emit: (event) => events.push(event),
    });

    expect(result.kind).toBe('continue');
    const content = String(result.payload.messages[0]?.content);
    expect(content).toContain('1st_Loop recalled text');
    expect(content).toContain('3rd_Loop recalled text');
    expect(content).not.toContain('2nd_Loop recalled text');
    expect(result.payload.narrativeRecall?.timelines.map((entry) => entry.name))
      .toEqual(['1st_Loop', '3rd_Loop']);
    expect(events).toContainEqual({
      type: 'narrative_timeline_failed',
      sessionId,
      turnId,
      timeline: '2nd_Loop',
      code: 'narrative/http_error',
      message: 'timeline failed',
      retryable: true,
    });
  });

  it('全部 timeline 失败时降级为空上下文而不让 Turn 失败', async () => {
    const hooks = new HookBus();
    const events: EmaStreamEvent[] = [];
    registerConversationHooks(hooks, {
      session: {} as never,
      narrative: {
        route: async () => ({ routes: { '1st_Loop': 'first' } }),
        queryOne: async () => {
          throw new NarrativeRequestError('timeout', {
            code: 'narrative/timeout',
            retryable: true,
          });
        },
      } as never,
    });
    const originalMessages = [{ role: 'user' as const, content: 'query' }];

    const result = await hooks.trigger('beforeLlm', {
      sessionId,
      turnId,
      payload: {
        iteration: 1,
        llmCallId: 'llm-call-all-failed' as never,
        messages: originalMessages,
        mode: 'narrative',
        userInput: 'query',
        providerId: 'provider',
        model: 'model',
      },
      emit: (event) => events.push(event),
    });

    expect(result.kind).toBe('continue');
    expect(result.payload.messages).toEqual(originalMessages);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'narrative_timeline_failed',
      timeline: '1st_Loop',
      code: 'narrative/timeout',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'system_warning',
      level: 'warn',
    }));
  });

  it('用户取消任一 timeline 时终止整个 Narrative Hook', async () => {
    const hooks = new HookBus();
    registerConversationHooks(hooks, {
      session: {} as never,
      narrative: {
        route: async () => ({ routes: { '1st_Loop': 'first', '2nd_Loop': 'second' } }),
        queryOne: async () => {
          throw new DOMException('user stop', 'AbortError');
        },
      } as never,
    });

    const result = await hooks.trigger('beforeLlm', {
      sessionId,
      turnId,
      payload: {
        iteration: 1,
        llmCallId: 'llm-call-cancelled' as never,
        messages: [{ role: 'user', content: 'query' }],
        mode: 'narrative',
        userInput: 'query',
        providerId: 'provider',
        model: 'model',
      },
    });

    expect(result).toMatchObject({
      kind: 'abort',
      reason: expect.stringContaining('user stop'),
    });
  });
});
