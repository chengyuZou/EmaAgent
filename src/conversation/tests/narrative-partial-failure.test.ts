// 测试 Narrative 多时间线召回保留成功分区，并结构化报告失败分区。

import { describe, expect, it } from 'vitest';
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { EmaStreamEvent } from '@ema-agent/events';
import { NarrativeRequestError } from '@ema-agent/narrative';
import { prepareNarrativeContribution } from '../narrativeRecall.js';

const sessionId = 'session-narrative' as SessionId;
const turnId = 'turn-narrative' as TurnId;

describe('Narrative 部分失败', () => {
  it('一条 timeline 失败时仍向 LLM 注入其他成功结果', async () => {
    const events: EmaStreamEvent[] = [];
    const deps = {
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
    } as never;

    const result = await prepareNarrativeContribution(deps, {
      sessionId,
      turnId,
      userInput: '发生了什么？',
      emit: (event) => events.push(event),
    });

    const content = String(result?.contribution.message.content);
    expect(content).toContain('1st_Loop recalled text');
    expect(content).toContain('3rd_Loop recalled text');
    expect(content).not.toContain('2nd_Loop recalled text');
    expect(result?.timelines.map((entry) => entry.name))
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
    const events: EmaStreamEvent[] = [];
    const deps = {
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
    } as never;

    const result = await prepareNarrativeContribution(deps, {
      sessionId,
      turnId,
      userInput: 'query',
      emit: (event) => events.push(event),
    });

    expect(result).toBeNull();
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

  it('用户取消任一 timeline 时终止整个 Narrative 召回', async () => {
    const deps = {
      session: {} as never,
      narrative: {
        route: async () => ({ routes: { '1st_Loop': 'first', '2nd_Loop': 'second' } }),
        queryOne: async () => {
          throw new DOMException('user stop', 'AbortError');
        },
      } as never,
    } as never;

    await expect(prepareNarrativeContribution(deps, {
      sessionId,
      turnId,
      userInput: 'query',
    })).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('user stop'),
    });
  });
});
