// 测试 Turn 初始背景消息的段序、空字段省略与 Git 摘要的凭据防线。
import { describe, expect, it } from 'vitest';
import type { GitSummary } from '@ema-agent/git';
import type { Goal } from '@ema-agent/goal';
import { renderTurnReminder } from '../prepare/turnReminder.js';

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
      goal: null,
    });
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('## 当前日期\n2026-08-23');
    expect(text).toContain('本 Turn 开始时的状态');
    expect(text).toContain('更新更晚的 Tool Result 为准');
    expect(text).not.toContain('## Git 状态');
  });

  it('段序固定：日期 → Git → Work 摘要 → 当前角色关系记忆 → Narrative → 任务 → Scratchpad', () => {
    const text = renderTurnReminder({
      currentDate: '2026-08-23',
      goal: null,
      gitSummary: GIT_OK,
      memoryWork: '工作摘要',
      memoryRelationship: '共享用户记忆与当前角色记忆',
      narrativeRecall: '剧情检索结果',
      taskReminder: '任务提醒',
      scratchpad: '已有文件：a.txt',
    });
    const order = [
      '## 当前日期',
      '## Git 状态',
      '## Work 记忆摘要',
      '## Relationship 记忆',
      '## Narrative 检索结果',
      '## 任务提醒',
      '## Scratchpad',
      '## Goal',
    ];
    const positions = order.map(marker => text.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('Git 摘要不含 originUrl（凭据防线）', () => {
    const text = renderTurnReminder({
      currentDate: '2026-08-23',
      goal: null,
      gitSummary: GIT_OK,
    });
    expect(text).toContain('分支: main');
    expect(text).not.toContain('token@example.com');
  });

  it('active Goal 带身份, 版本, 正文与反馈, 不把反馈当成完成事实', () => {
    const text = renderTurnReminder({ currentDate: '2026-09-29', goal: goal() });
    expect(text).toContain('Goal ID: goal-1');
    expect(text).toContain('Version: 2');
    expect(text).toContain('Status: active');
    expect(text).toContain('整理 8 个 README');
    expect(text).toContain('已整理 2/8');
    expect(text).toContain('模型自报, 不是完成判定');
    expect(text).toContain('旧目标要求不再有效');
  });

  it('无 Goal 明确撤销旧目标, paused 不暴露可执行目标正文', () => {
    const none = renderTurnReminder({ currentDate: '2026-09-29', goal: null });
    expect(none).toContain('当前没有激活的 Goal');
    expect(none).toContain('不再执行历史 Goal');
    const paused = renderTurnReminder({
      currentDate: '2026-09-29',
      goal: { ...goal(), status: 'paused' },
    });
    expect(paused).toContain('当前 Goal 已暂停');
    expect(paused).not.toContain('整理 8 个 README');
    expect(paused).not.toContain('GoalUpdate(status=active');
  });
});

function goal(): Goal {
  return {
    id: 'goal-1', sessionId: 'session-1', objective: '整理 8 个 README',
    feedback: '已整理 2/8', status: 'active', version: 2, reason: null, error: null,
    createdAt: 1, updatedAt: 2, completedAt: null,
  };
}
