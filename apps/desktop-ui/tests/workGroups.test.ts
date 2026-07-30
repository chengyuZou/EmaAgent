// 测试工作区模型:分组、正文切分、动词摘要、当前动作、失败计数、已编辑文件汇总与时间格式。
import { describe, expect, it } from 'vitest';
import type { FileChangePresentation } from '@ema-agent/tools';
import type { AssistantSlice } from '../src/stores/conversation-store.js';
import {
  editedFiles,
  formatTurnTime,
  formatWorkDuration,
  groupSlices,
  liveAction,
  splitWorkAnswer,
  tallySummary,
  tallyTools,
} from '../src/chat/history/workGroups.js';

type ToolUseSlice = Extract<AssistantSlice, { type: 'tool_use' }>;

function tool(name: string, overrides: Partial<ToolUseSlice> = {}): ToolUseSlice {
  return {
    type: 'tool_use',
    name,
    callId: `c-${Math.random()}`,
    ...overrides,
  } as ToolUseSlice;
}

function text(t: string): AssistantSlice {
  return { type: 'text', text: t } as AssistantSlice;
}

function fileChange(filePath: string, additions: number, deletions: number, operation: 'create' | 'update' = 'update'): FileChangePresentation {
  return { kind: 'file_change', operation, filePath, unifiedDiff: '', additions, deletions, truncated: false };
}

describe('groupSlices', () => {
  it('连续 tool_use 收为一组,单个保持 single', () => {
    const groups = groupSlices([text('a'), tool('Bash'), tool('Edit'), text('b'), tool('Grep')]);
    expect(groups.map((g) => g.kind)).toEqual(['single', 'tool_group', 'single', 'single']);
  });
});

describe('splitWorkAnswer', () => {
  it('末尾连续 text 是正文,其余进工作区', () => {
    const groups = groupSlices([text('先想'), tool('Bash'), text('最终回复')]);
    const { work, answer } = splitWorkAnswer(groups);
    expect(work).toHaveLength(2);
    expect(answer).toHaveLength(1);
  });

  it('以工具结尾时没有正文', () => {
    const groups = groupSlices([tool('Bash'), tool('Edit')]);
    expect(splitWorkAnswer(groups).answer).toHaveLength(0);
  });
});

describe('tallyTools / tallySummary', () => {
  it('动词归类与错误计数', () => {
    const slices = [
      tool('Bash'),
      tool('Bash', { error: { code: 'tool/error', message: 'x' } as never }),
      tool('Edit'),
      tool('Grep'),
    ];
    const tally = tallyTools(slices);
    expect(tally).toEqual({ commands: 2, fileEdits: 1, otherTools: 1, errors: 1 });
    expect(tallySummary(slices, tally)).toEqual(['运行了 2 个命令', '编辑了 1 个文件', '运行了 1 个工具']);
  });

  it('单个编辑给具体文件与增删', () => {
    const slices = [tool('Edit', { presentation: fileChange('src/a/b.ts', 3, 1) })];
    expect(tallySummary(slices, tallyTools(slices))).toEqual(['已编辑 b.ts +3 -1']);
  });

  it('单个创建显示已创建', () => {
    const slices = [tool('Write', { presentation: fileChange('new.ts', 10, 0, 'create') })];
    expect(tallySummary(slices, tallyTools(slices))).toEqual(['已创建 new.ts +10 -0']);
  });

  it('单个命令显示截断命令', () => {
    const slices = [tool('Bash', { args: { command: 'pnpm test' } })];
    expect(tallySummary(slices, tallyTools(slices))).toEqual(['运行了 pnpm test']);
  });
});

describe('liveAction', () => {
  it('进行中的编辑', () => {
    const slices = [tool('Bash', { result: {} as never }), tool('Edit', { args: { file_path: 'src/x/y.ts' } })];
    expect(liveAction(slices, true)).toEqual({ kind: 'editing', file: 'y.ts' });
  });

  it('进行中的命令', () => {
    const slices = [tool('Bash', { args: { command: 'pnpm build' } })];
    expect(liveAction(slices, true)).toEqual({ kind: 'command', command: 'pnpm build' });
  });

  it('工具有结果后等待模型', () => {
    const slices = [tool('Bash', { result: {} as never })];
    expect(liveAction(slices, true)).toEqual({ kind: 'waiting' });
  });

  it('非流式返回 null', () => {
    expect(liveAction([tool('Bash')], false)).toBeNull();
  });
});

describe('editedFiles', () => {
  it('同文件多次编辑留最后一次,合计增删', () => {
    const slices = [
      tool('Edit', { presentation: fileChange('a.ts', 3, 1) }),
      tool('Edit', { presentation: fileChange('b.ts', 2, 0) }),
      tool('Edit', { presentation: fileChange('a.ts', 5, 2) }),
    ];
    const result = editedFiles(slices);
    expect(result.files).toHaveLength(2);
    expect(result.files.find((f) => f.path === 'a.ts')).toMatchObject({ additions: 5, deletions: 2 });
    expect(result.additions).toBe(7);
    expect(result.deletions).toBe(2);
  });
});

describe('时间格式', () => {
  it('当年显示月日时分,跨年显示年月日', () => {
    const now = new Date(2026, 6, 30, 12, 0).getTime();
    expect(formatTurnTime(new Date(2026, 6, 30, 9, 5).getTime(), now)).toBe('7月30日 09:05');
    expect(formatTurnTime(new Date(2025, 11, 3, 9, 5).getTime(), now)).toBe('2025年12月3日');
  });

  it('工作时长分档', () => {
    expect(formatWorkDuration(45_000)).toBe('45s');
    expect(formatWorkDuration(48 * 60_000 + 32_000)).toBe('48m 32s');
    expect(formatWorkDuration(3_725_000)).toBe('1h 2m 5s');
  });
});
