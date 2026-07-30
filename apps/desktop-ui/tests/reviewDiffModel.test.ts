// 测试 Review 的 unified diff 解析、折叠段推导与分列配对。
import { describe, expect, it } from 'vitest';
import { buildSegments, parseUnifiedDiff, toSplitRows } from '../src/chat/review/diffModel.js';

const SAMPLE = [
  'diff --git a/a.ts b/a.ts',
  'index 111..222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,6 +1,6 @@ function x',
  ' c1',
  ' c2',
  '-old',
  '+new',
  ' c3',
  ' c4',
  ' c5',
  '@@ -20,3 +20,4 @@ function y',
  ' d1',
  '+added',
  ' d2',
  ' d3',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('解析 hunk 头与行号推进', () => {
    const { hunks } = parseUnifiedDiff(SAMPLE);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, header: '@@ -1,6 +1,6 @@ function x' });
    expect(hunks[0]?.lines.map((line) => line.kind)).toEqual([
      'context', 'context', 'del', 'add', 'context', 'context', 'context',
    ]);
    expect(hunks[0]?.lines[2]).toMatchObject({ oldLine: 3, newLine: null, text: 'old' });
    expect(hunks[0]?.lines[3]).toMatchObject({ oldLine: null, newLine: 3, text: 'new' });
    expect(hunks[0]?.lines[6]).toMatchObject({ oldLine: 6, newLine: 6 });
    expect(hunks[1]).toMatchObject({ oldStart: 20, newStart: 20 });
  });

  it('空 diff 与无 hunk diff', () => {
    expect(parseUnifiedDiff('').hunks).toEqual([]);
    expect(parseUnifiedDiff('diff --git a/x b/x\nBinary files differ\n').hunks).toEqual([]);
  });
});

describe('buildSegments', () => {
  it('短上下文不折叠,hunk 间隔生成 gap 段', () => {
    const segments = buildSegments(parseUnifiedDiff(SAMPLE));
    const gap = segments.find((segment) => segment.kind === 'gap');
    // 第一个 hunk 消费旧侧 6 行(1..6),第二个 hunk 从 20 开始,间隔 13 行。
    expect(gap).toMatchObject({ lineCount: 13 });
    expect(segments.some((segment) => segment.kind === 'collapsible')).toBe(false);
  });

  it('长上下文折叠中段,两端各留 keep 行', () => {
    const contextLines = Array.from({ length: 10 }, (_, i) => ` c${i}`);
    const diff = [
      '@@ -1,13 +1,13 @@',
      ...contextLines.slice(0, 5),
      '-a',
      '+b',
      ...contextLines,
      '-c',
      '+d',
      ...contextLines.slice(0, 5),
      '',
    ].join('\n');
    const segments = buildSegments(parseUnifiedDiff(diff), 3);
    const collapsible = segments.filter((segment) => segment.kind === 'collapsible');
    // 只有中段 10 行上下文超过 keep*2:折叠中段 4 行,两端各 3 行。
    expect(collapsible).toHaveLength(1);
    expect(collapsible[0]?.kind === 'collapsible' && collapsible[0].lines).toHaveLength(4);
  });
});

describe('toSplitRows', () => {
  it('删除与新增按序配对,上下文占两侧,落单补空', () => {
    const rows = toSplitRows([
      { kind: 'context', text: 'c', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'd1', oldLine: 2, newLine: null },
      { kind: 'del', text: 'd2', oldLine: 3, newLine: null },
      { kind: 'add', text: 'a1', oldLine: null, newLine: 2 },
      { kind: 'add', text: 'a2', oldLine: null, newLine: 3 },
      { kind: 'add', text: 'a3', oldLine: null, newLine: 4 },
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      left: { kind: 'context', line: 1 }, right: { kind: 'context', line: 1 },
    });
    expect(rows[1]).toMatchObject({
      left: { kind: 'del', text: 'd1' }, right: { kind: 'add', text: 'a1' },
    });
    expect(rows[3]).toMatchObject({
      left: { kind: 'empty', line: null }, right: { kind: 'add', text: 'a3' },
    });
  });
});
