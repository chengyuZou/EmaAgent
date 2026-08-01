// 测试原子 Narrative Recall 的结构化部分失败、空结果、整体失败与取消语义。
import { describe, expect, it } from 'vitest';
import type { SessionId, TurnId } from '@ema-agent/ids';
import { NarrativeRequestError } from '../errors.js';
import type { NarrativeEvent } from '../events.js';
import { prepareNarrativeRecall } from '../recall.js';

const sessionId = 'session-narrative' as SessionId;
const turnId = 'turn-narrative' as TurnId;

describe('Narrative 原子召回', () => {
  it('一次响应保留成功时间线和结构化部分失败', async () => {
    const events: NarrativeEvent[] = [];
    const client = {
      recall: async () => ({
        generationId: 'generation-1',
        routes: {
          '1st_Loop': 'first',
          '2nd_Loop': 'second',
          '3rd_Loop': 'third',
        },
        results: {
          '1st_Loop': 'first recalled text',
          '3rd_Loop': 'third recalled text',
        },
        failures: [{
          timeline: '2nd_Loop',
          code: 'timeline_query_failed' as const,
          message: 'timeline failed',
          retryable: true,
        }],
      }),
    } as never;

    const result = await prepareNarrativeRecall(client, {
      sessionId,
      turnId,
      userInput: '发生了什么？',
      emit: (event) => events.push(event),
    });

    expect(result.generationId).toBe('generation-1');
    expect(result.contextText).toContain('first recalled text');
    expect(result.contextText).toContain('third recalled text');
    expect(result.timelines.map((entry) => entry.name))
      .toEqual(['1st_Loop', '3rd_Loop']);
    expect(result.failures).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual([
      'narrative_recall_started',
      'narrative_recall_completed',
    ]);
    expect(events[1]).toMatchObject({
      generationId: 'generation-1',
      timelineOrder: ['1st_Loop', '2nd_Loop', '3rd_Loop'],
      failures: [{ timeline: '2nd_Loop', code: 'timeline_query_failed' }],
    });
  });

  it('空路由是成功完成且不伪造不可用状态', async () => {
    const events: NarrativeEvent[] = [];
    const client = {
      recall: async () => ({
        generationId: 'generation-empty',
        routes: {},
        results: {},
        failures: [],
      }),
    } as never;

    await expect(prepareNarrativeRecall(client, {
      sessionId,
      turnId,
      userInput: 'query',
      emit: (event) => events.push(event),
    })).resolves.toEqual({
      generationId: 'generation-empty',
      timelines: [],
      failures: [],
      contextText: null,
    });
    expect(events.at(-1)).toMatchObject({
      type: 'narrative_recall_completed',
      timelineOrder: [],
    });
  });

  it('整体请求失败只发布一次 failed 后向上抛错', async () => {
    const events: NarrativeEvent[] = [];
    const error = new NarrativeRequestError('timeout', {
      code: 'narrative/timeout',
      retryable: true,
    });
    const client = { recall: async () => { throw error; } } as never;

    await expect(prepareNarrativeRecall(client, {
      sessionId,
      turnId,
      userInput: 'query',
      emit: (event) => events.push(event),
    })).rejects.toBe(error);
    expect(events.map((event) => event.type)).toEqual([
      'narrative_recall_started',
      'narrative_recall_failed',
    ]);
  });

  it('用户取消不伪装成剧情检索失败', async () => {
    const events: NarrativeEvent[] = [];
    const client = {
      recall: async () => { throw new DOMException('user stop', 'AbortError'); },
    } as never;

    await expect(prepareNarrativeRecall(client, {
      sessionId,
      turnId,
      userInput: 'query',
      emit: (event) => events.push(event),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(events.map((event) => event.type)).toEqual(['narrative_recall_started']);
  });
});
