// 测试 NarrativeSearch 只接收宿主授予的按需检索能力，并诚实区分完整、部分和空结果。
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import {
  NarrativeSearchTool,
  type BuiltinToolContext,
} from '../index.js';

function hostContext(
  narrativeSearch?: BuiltinToolContext['narrativeSearch'],
): BuiltinToolContext {
  return {
    sessionId: asSessionId('session-narrative-tool'),
    turnId: asTurnId('turn-narrative-tool'),
    workspaceRoot: '',
    signal: new AbortController().signal,
    narrativeSearch,
  };
}

describe('NarrativeSearchTool', () => {
  it('没有 auto 策略授予的 Port 时拒绝执行', () => {
    expect(
      NarrativeSearchTool.unsafeValidateContext(hostContext()),
    ).toEqual({
      valid: false,
      reason: '当前 Turn 未启用按需剧情检索。',
    });
  });

  it('把聚焦查询交给宿主，并保留分时间线结果', async () => {
    const narrativeSearch = vi.fn(async () => ({
      timelines: [{
        name: '1st_Loop',
        charCount: 4,
        text: '剧情正文',
      }],
      contextText: '## 1st_Loop\n剧情正文',
      failedTimelineCount: 1,
    }));
    const context = NarrativeSearchTool.unsafeValidateContext(
      hostContext(narrativeSearch),
    );
    if (!context.valid) throw new Error(context.reason);

    const input = NarrativeSearchTool.parseInput({ query: '  查询角色过去  ' });
    await expect(
      NarrativeSearchTool.execute(input, context.context),
    ).resolves.toEqual({
      status: 'partial',
      timelines: [{
        name: '1st_Loop',
        charCount: 4,
        text: '剧情正文',
      }],
      failedTimelineCount: 1,
    });
    expect(narrativeSearch).toHaveBeenCalledWith(
      '查询角色过去',
      expect.any(AbortSignal),
    );
  });

  it('无正文且没有失败时返回 empty', async () => {
    const context = NarrativeSearchTool.unsafeValidateContext(hostContext(
      async () => ({
        timelines: [{ name: '2nd_Loop', charCount: 0, text: '' }],
        contextText: null,
        failedTimelineCount: 0,
      }),
    ));
    if (!context.valid) throw new Error(context.reason);

    await expect(
      NarrativeSearchTool.execute({ query: '未知细节' }, context.context),
    ).resolves.toMatchObject({
      status: 'empty',
      failedTimelineCount: 0,
    });
  });
});
