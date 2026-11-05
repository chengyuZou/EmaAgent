import { describe, expect, it, vi } from 'vitest';
import type { NarrativeRecallResult, NarrativeTimelineResult } from '@ema-agent/narrative';
import type { ToolInvocation, ToolUseContext } from '@ema-agent/tools';
import { NarrativeSearchTool } from '../tools/NarrativeSearchTool/NarrativeSearchTool.js';
import { narrativeSearchResultCopyText } from '../tools/NarrativeSearchTool/UI.js';

function invocation(): ToolInvocation {
  return {
    sessionId: 'session-narrative-tool',
    turnId: 'turn-narrative-tool',
    toolCallId: 'toolcall-narrative-tool',
    signal: new AbortController().signal,
  };
}

function resultWithChunk(content: string): NarrativeTimelineResult {
  return { entities: [], relations: [], chunks: [{ chunk_id: 'chunk-a', content }] };
}

describe('NarrativeSearchTool', () => {
  it('没有查询函数时拒绝装配, 有查询函数时只取得对应能力', () => {
    expect(NarrativeSearchTool.validateContext({} as never)).toEqual({
      valid: false,
      reason: '当前 Turn 未提供可用的 Narrative 查询能力.',
    });
    const narrativeSearch: NonNullable<ToolUseContext['narrativeSearch']> = async () => new Map();
    expect(NarrativeSearchTool.validateContext({ narrativeSearch } as never))
      .toEqual({ valid: true, context: { narrativeSearch } });
  });

  it('Map 转为可保存的 Tool 结果, 前端和模型能读到相同正文与失败说明', async () => {
    const narrativeSearch = vi.fn(async (): Promise<NarrativeRecallResult> => new Map([
      ['1st_Loop', resultWithChunk('剧情正文')],
      ['2nd_Loop', { message: '检索失败' }],
    ]));
    const input = NarrativeSearchTool.inputSchema.parse({ query: '  查询角色过去  ' });
    const current = invocation();
    const result = await NarrativeSearchTool.execute(input, { narrativeSearch }, current);
    expect(narrativeSearch).toHaveBeenCalledWith('查询角色过去', undefined, current.signal);
    expect(result).toEqual({
      status: 'partial',
      timelines: [{ timelineId: '1st_Loop', ...resultWithChunk('剧情正文') }],
      failures: [{ timelineId: '2nd_Loop', message: '检索失败' }],
    });
    const saved = JSON.parse(JSON.stringify(result));
    expect(saved).toEqual(result);
    expect(narrativeSearchResultCopyText(saved)).toContain('剧情正文');
    const content = String(NarrativeSearchTool.mapResultToModelContent!(saved));
    expect(JSON.parse(content)).toEqual(saved);
  });

  it('同一 Turn 可以继续查询, mode 和取消信号原样传入', async () => {
    const narrativeSearch = vi.fn(async (): Promise<NarrativeRecallResult> => new Map());
    const input = NarrativeSearchTool.inputSchema.parse({ query: '角色关系', mode: 'global' });
    const current = invocation();
    await NarrativeSearchTool.execute(input, { narrativeSearch }, current);
    await NarrativeSearchTool.execute(input, { narrativeSearch }, current);
    expect(narrativeSearch).toHaveBeenCalledTimes(2);
    expect(narrativeSearch).toHaveBeenLastCalledWith('角色关系', 'global', current.signal);
  });

  it('只转交补齐语境后的完整问题, 不接收周目或关键词参数', async () => {
    const narrativeSearch = vi.fn(async (): Promise<NarrativeRecallResult> => new Map());
    const query = '第三周目真结局里, 城崎诺亚最后去了哪里? 不用展开之前的案件.';
    const input = NarrativeSearchTool.inputSchema.parse({ query });
    const current = invocation();
    await NarrativeSearchTool.execute(input, { narrativeSearch }, current);
    expect(narrativeSearch).toHaveBeenCalledWith(query, undefined, current.signal);
    expect(NarrativeSearchTool.inputSchema.safeParse({
      query, timelines: ['3rd_Loop'], high_level_keywords: [], low_level_keywords: [],
    }).success).toBe(false);
  });

  it('无正文为 empty, 全部失败为 unavailable, 有正文且无失败为 found', async () => {
    const narrativeSearch = vi.fn<NonNullable<ToolUseContext['narrativeSearch']>>()
      .mockResolvedValueOnce(new Map([['2nd_Loop', { entities: [], relations: [], chunks: [] }]]))
      .mockResolvedValueOnce(new Map([
        ['1st_Loop', { message: '检索失败' }],
      ]))
      .mockResolvedValueOnce(new Map([['3rd_Loop', resultWithChunk('正文')]]));
    const context = { narrativeSearch };
    const input = { query: '世界状态' };
    await expect(NarrativeSearchTool.execute(input, context, invocation()))
      .resolves.toMatchObject({ status: 'empty' });
    await expect(NarrativeSearchTool.execute(input, context, invocation()))
      .resolves.toMatchObject({ status: 'unavailable' });
    await expect(NarrativeSearchTool.execute(input, context, invocation()))
      .resolves.toMatchObject({ status: 'found' });
  });

  it('取消和路由错误不伪装成 empty', async () => {
    const error = new Error('查询已取消');
    const narrativeSearch = vi.fn().mockRejectedValue(error);
    await expect(NarrativeSearchTool.execute({ query: '角色关系' }, { narrativeSearch }, invocation()))
      .rejects.toBe(error);
  });

  it('空结果不把旧角色知识当作检索结果', () => {
    expect(String(NarrativeSearchTool.mapResultToModelContent!({
      status: 'empty', timelines: [], failures: [],
    }))).toBe(JSON.stringify({ status: 'empty', timelines: [], failures: [] }));
    expect(NarrativeSearchTool.getToolUseSummary?.({ query: '角色过去' }))
      .toBe('检索剧情资料:角色过去');
  });
});

it('只有图描述也算找到材料, 模型和 JSON 复制都保留节点与关系', async () => {
  const graphResult: NarrativeTimelineResult = {
    entities: [{ entity_name: '角色', entity_type: 'Person', description: '图中的描述' }],
    relations: [{ relation_id: 1, source_entity: '角色', target_entity: '角色', description: '关系描述', weight: 1 }],
    chunks: [],
  };
  const narrativeSearch: NonNullable<ToolUseContext['narrativeSearch']> = async () => new Map([
    ['1st_Loop', graphResult],
  ]);
  const result = await NarrativeSearchTool.execute({ query: '角色' }, { narrativeSearch }, invocation());
  expect(result.status).toBe('found');
  expect(JSON.parse(String(NarrativeSearchTool.mapResultToModelContent!(result)))).toEqual(result);
  expect(JSON.parse(narrativeSearchResultCopyText(result)!)).toEqual(result);
});
