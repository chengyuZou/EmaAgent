// 测试 Narrative 多时间线召回保留成功分区、报告失败并响应取消。

import { describe, expect, it } from 'vitest';
import type { SessionId, TurnId } from '@ema-agent/ids';
import { NarrativeRequestError } from '../errors.js';
import type { NarrativeEvent } from '../events.js';
import { prepareNarrativeRecall } from '../recall.js';

const sessionId = 'session-narrative' as SessionId;
const turnId = 'turn-narrative' as TurnId;

describe('Narrative 多时间线召回', () => {
  it('一条时间线失败时仍返回其他成功结果', async () => {
    const events: NarrativeEvent[] = [];
    const client = {
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
    } as never;

    const result = await prepareNarrativeRecall(client, {
      sessionId,
      turnId,
      userInput: '发生了什么？',
      emit: (event) => events.push(event),
    });

    expect(result.contextText).toContain('1st_Loop recalled text');
    expect(result.contextText).toContain('3rd_Loop recalled text');
    expect(result.contextText).not.toContain('2nd_Loop recalled text');
    expect(result.timelines.map((entry) => entry.name))
      .toEqual(['1st_Loop', '3rd_Loop']);
    expect(result.failedTimelineCount).toBe(1);
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

  it('全部失败时返回明确状态而不伪造模型上下文', async () => {
    const events: NarrativeEvent[] = [];
    const client = {
      route: async () => ({ routes: { '1st_Loop': 'first' } }),
      queryOne: async () => {
        throw new NarrativeRequestError('timeout', {
          code: 'narrative/timeout',
          retryable: true,
        });
      },
    } as never;

    const result = await prepareNarrativeRecall(client, {
      sessionId,
      turnId,
      userInput: 'query',
      emit: (event) => events.push(event),
    });

    expect(result).toEqual({
      timelines: [],
      contextText: null,
      failedTimelineCount: 1,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'narrative_timeline_failed',
      timeline: '1st_Loop',
      code: 'narrative/timeout',
    }));
  });

  it('用户取消任一时间线时终止整次召回', async () => {
    const client = {
      route: async () => ({
        routes: { '1st_Loop': 'first', '2nd_Loop': 'second' },
      }),
      queryOne: async () => {
        throw new DOMException('user stop', 'AbortError');
      },
    } as never;

    await expect(prepareNarrativeRecall(client, {
      sessionId,
      turnId,
      userInput: 'query',
    })).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('user stop'),
    });
  });
});
