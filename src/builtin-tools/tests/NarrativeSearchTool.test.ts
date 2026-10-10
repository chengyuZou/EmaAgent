import { describe, expect, it, vi } from 'vitest';
import type { NarrativeRecallResult } from '@ema-agent/narrative';
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

describe('NarrativeSearchTool', () => {
  it('没有可用绑定时拒绝装配, 有查询函数时只取得对应能力', () => {
    expect(NarrativeSearchTool.validateContext({} as never)).toEqual({
      valid: false,
      reason: '当前 Turn 未配置可用的 Narrative 模型绑定。',
    });
    const narrativeSearch: NonNullable<ToolUseContext['narrativeSearch']> = async () => new Map();
    expect(NarrativeSearchTool.validateContext({ narrativeSearch } as never))
      .toEqual({ valid: true, context: { narrativeSearch } });
  });

  it('Map 转为可保存的 Tool 结果, 前端和模型能读到相同正文与失败说明', async () => {
    const narrativeSearch = vi.fn(async (): Promise<NarrativeRecallResult> => new Map([
      ['1st_Loop', { text: '剧情正文' }],
      ['2nd_Loop', { code: 'timeline_query_failed', message: '检索失败' }],
    ]));
    const input = NarrativeSearchTool.inputSchema.parse({ query: '  查询角色过去  ' });
    const current = invocation();
    const result = await NarrativeSearchTool.execute(input, { narrativeSearch }, current);
    expect(narrativeSearch).toHaveBeenCalledWith('查询角色过去', undefined, current.signal);
    expect(result).toEqual({
      status: 'partial',
      timelines: [{ name: '1st_Loop', text: '剧情正文' }],
      failures: [{ timeline: '2nd_Loop', message: '检索失败' }],
    });
    const saved = JSON.parse(JSON.stringify(result));
    expect(saved).toEqual(result);
    expect(narrativeSearchResultCopyText(saved)).toContain('剧情正文');
    const content = String(NarrativeSearchTool.mapResultToModelContent!(saved));
    expect(content).toContain('## 1st_Loop\n剧情正文');
    expect(content).toContain('检索失败的剧情线：2nd_Loop (检索失败)');
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

  it('无正文为 empty, 全部失败为 unavailable, 有正文且无失败为 found', async () => {
    const narrativeSearch = vi.fn<NonNullable<ToolUseContext['narrativeSearch']>>()
      .mockResolvedValueOnce(new Map([['2nd_Loop', { text: '' }]]))
      .mockResolvedValueOnce(new Map([
        ['1st_Loop', { code: 'timeline_query_failed', message: '检索失败' }],
      ]))
      .mockResolvedValueOnce(new Map([['3rd_Loop', { text: '正文' }]]));
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
    }))).toContain('未返回可用剧情资料');
    expect(NarrativeSearchTool.getToolUseSummary?.({ query: '角色过去' }))
      .toBe('检索剧情资料：角色过去');
  });
});
