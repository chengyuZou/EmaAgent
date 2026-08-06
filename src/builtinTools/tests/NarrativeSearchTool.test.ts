// 验证 NarrativeSearchTool 只消费宿主授予的检索端口, 并诚实区分完整/部分/空/不可用结果。
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import type { NarrativeSearchPort } from '@ema-agent/narrative';
import type { ToolInvocation } from '@ema-agent/tools';
import { NarrativeSearchTool } from '../tools/NarrativeSearchTool/NarrativeSearchTool.js';

function invocation(): ToolInvocation {
  return Object.freeze({
    sessionId: asSessionId('session-narrative-tool'),
    turnId: asTurnId('turn-narrative-tool'),
    toolCallId: asToolCallId('toolcall-narrative-tool'),
    signal: new AbortController().signal,
  });
}

describe('NarrativeSearchTool validateContext', () => {
  it('没有 auto 策略授予的 Port 时拒绝执行', () => {
    expect(NarrativeSearchTool.validateContext({} as never)).toEqual({
      valid: false,
      reason: '当前 Turn 未启用按需剧情检索。',
    });
  });

  it('有 Port 时只投影窄 Context', () => {
    const narrativeSearch: NarrativeSearchPort = async () => ({
      generationId: 'generation-1',
      timelines: [],
      failures: [],
      contextText: null,
    });
    const result = NarrativeSearchTool.validateContext({
      narrativeSearch,
    } as never);
    expect(result).toEqual({ valid: true, context: { narrativeSearch } });
  });
});

describe('NarrativeSearchTool execute', () => {
  it('把聚焦查询交给宿主并保留分时间线结果', async () => {
    const narrativeSearch = vi.fn(async () => ({
      generationId: 'generation-1',
      timelines: [{
        name: '1st_Loop',
        charCount: 4,
        text: '剧情正文',
      }],
      contextText: '## 1st_Loop\n剧情正文',
      failures: [{
        timeline: '2nd_Loop',
        code: 'timeline_query_failed' as const,
        message: '检索失败',
        retryable: true,
      }],
    }));
    const context = { narrativeSearch };
    const input = NarrativeSearchTool.inputSchema.parse({ query: '  查询角色过去  ' });

    const result = await NarrativeSearchTool.execute(
      input,
      context,
      invocation(),
    );
    expect(result).toEqual({
      status: 'partial',
      timelines: [{
        name: '1st_Loop',
        charCount: 4,
        text: '剧情正文',
      }],
      failures: [{
        timeline: '2nd_Loop',
        code: 'timeline_query_failed',
        message: '检索失败',
        retryable: true,
      }],
    });
    expect(narrativeSearch).toHaveBeenCalledWith(
      '查询角色过去',
      expect.any(AbortSignal),
    );
  });

  it('无正文且没有失败时返回 empty', async () => {
    const context = {
      narrativeSearch: async () => ({
        generationId: 'generation-2',
        timelines: [{ name: '2nd_Loop', charCount: 0, text: '' }],
        contextText: null,
        failures: [],
      }),
    };
    await expect(
      NarrativeSearchTool.execute({ query: '未知细节' }, context, invocation()),
    ).resolves.toMatchObject({ status: 'empty', failures: [] });
  });

  it('有正文但存在失败时返回 partial, 全部失败且无正文时返回 unavailable', async () => {
    const context = {
      narrativeSearch: async () => ({
        generationId: 'generation-3',
        timelines: [{ name: '1st_Loop', charCount: 0, text: '' }],
        contextText: null,
        failures: [{
          timeline: '1st_Loop',
          code: 'timeline_query_failed' as const,
          message: '检索失败',
          retryable: true,
        }],
      }),
    };
    await expect(
      NarrativeSearchTool.execute({ query: '世界状态' }, context, invocation()),
    ).resolves.toMatchObject({ status: 'unavailable' });
  });
});

describe('NarrativeSearchTool 模型投影与摘要', () => {
  it('mapResultToModelContent 按时间线输出正文与失败说明', () => {
    const content = String(NarrativeSearchTool.mapResultToModelContent!({
      status: 'partial',
      timelines: [{ name: '1st_Loop', charCount: 4, text: '剧情正文' }],
      failures: [{
        timeline: '2nd_Loop',
        code: 'timeline_query_failed',
        message: '检索失败',
        retryable: true,
      }],
    }));
    expect(content).toContain('## 1st_Loop\n剧情正文');
    expect(content).toContain('2nd_Loop（检索失败）');
  });

  it('空结果给模型明确提示', () => {
    const content = String(NarrativeSearchTool.mapResultToModelContent!({
      status: 'empty',
      timelines: [],
      failures: [],
    }));
    expect(content).toContain('未返回可用剧情资料');
  });

  it('getToolUseSummary 返回查询摘要', () => {
    expect(NarrativeSearchTool.getToolUseSummary?.({ query: '角色过去' }))
      .toBe('检索剧情资料：角色过去');
  });
});
