// 测试原子 Narrative Recall 的结构化部分失败、空结果、整体失败与取消语义。
import { describe, expect, it } from 'vitest';
import { NarrativeRequestError } from '../errors.js';
import type { NarrativeEvent } from '../events.js';
import { prepareNarrativeRecall } from '../recall.js';

const sessionId = 'session-narrative';
const turnId = 'turn-narrative';
const llm = { baseUrl: 'http://llm.test/v1', modelId: 'test-model' };

describe('Narrative 原子召回', () => {
  it('一次响应保留成功时间线和结构化部分失败，并透传冻结连接与模式', async () => {
    const events: NarrativeEvent[] = [];
    const requests: unknown[] = [];
    const client = {
      recall: async (request: unknown) => {
        requests.push(request);
        return {
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
          }],
        };
      },
    } as never;

    const result = await prepareNarrativeRecall(client, {
      sessionId,
      turnId,
      userInput: '发生了什么？',
      llm,
      mode: 'hybrid',
      emit: (event) => events.push(event),
    });

    expect(requests).toEqual([{ query: '发生了什么？', llm, mode: 'hybrid' }]);
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
      timelineOrder: ['1st_Loop', '2nd_Loop', '3rd_Loop'],
      failures: [{ timeline: '2nd_Loop', code: 'timeline_query_failed' }],
    });
  });

  it('空路由是成功完成且不伪造不可用状态', async () => {
    const events: NarrativeEvent[] = [];
    const client = {
      recall: async () => ({
        routes: {},
        results: {},
        failures: [],
      }),
    } as never;

    await expect(prepareNarrativeRecall(client, {
      sessionId,
      turnId,
      userInput: 'query',
      llm,
      mode: 'hybrid',
      emit: (event) => events.push(event),
    })).resolves.toEqual({
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
    });
    const client = { recall: async () => { throw error; } } as never;

    await expect(prepareNarrativeRecall(client, {
      sessionId,
      turnId,
      userInput: 'query',
      llm,
      mode: 'hybrid',
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
      llm,
      mode: 'hybrid',
      emit: (event) => events.push(event),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(events.map((event) => event.type)).toEqual(['narrative_recall_started']);
  });
});
