// 测试 Turn 初始背景消息的段序、空字段省略与 Git 摘要的凭据防线。
import { describe, expect, it } from 'vitest';
import type { GitSummary } from '@ema-agent/git';
import { renderTurnReminder } from '../preparation/turnReminder.js';

const GIT_OK: GitSummary = {
  capability: 'ok',
  repoRoot: 'D:/proj',
  branch: 'main',
  headShortSha: null,
  unstaged: { filesChanged: 2, insertions: 10, deletions: 3 },
  staged: { filesChanged: 1, insertions: 4, deletions: 0 },
  untrackedCount: 5,
  upstream: 'origin/main',
  originUrl: 'https://token@example.com/repo.git',
};

describe('renderTurnReminder', () => {
  it('空输入也有日期与"本 Turn 开始"声明', () => {
    const text = renderTurnReminder({
      currentDate: '2026-08-23',
    });
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('## 当前日期\n2026-08-23');
    expect(text).toContain('本 Turn 开始时的状态');
    expect(text).toContain('更新更晚的 Tool Result 为准');
    expect(text).not.toContain('## Git 状态');
  });

  it('段序固定：日期 → Git → 两轨记忆 → Narrative → 任务 → Scratchpad', () => {
    const text = renderTurnReminder({
      currentDate: '2026-08-23',
      gitSummary: GIT_OK,
      memoryWork: '工作摘要',
      memoryRelationship: '关系摘要',
      narrativeRecall: '剧情检索结果',
      taskReminder: '任务提醒',
      scratchpad: '已有文件：a.txt',
    });
    const order = [
      '## 当前日期',
      '## Git 状态',
      '## Work 记忆摘要',
      '## Relationship 记忆摘要',
      '## Narrative 检索结果',
      '## 任务提醒',
      '## Scratchpad',
    ];
    const positions = order.map(marker => text.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('Git 摘要不含 originUrl（凭据防线）', () => {
    const text = renderTurnReminder({
      currentDate: '2026-08-23',
      gitSummary: GIT_OK,
    });
    expect(text).toContain('分支：main');
    expect(text).not.toContain('token@example.com');
  });
});
