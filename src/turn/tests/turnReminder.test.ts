// 测试 Turn 初始背景消息的段序、目录展示规则、空字段省略与 Git 摘要的凭据防线.
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

  it('段序固定：日期 → Git → Work 摘要 → 当前角色关系记忆 → Narrative → 任务 → Scratchpad → 子代理 → Goal', () => {
    const text = renderTurnReminder({
      currentDate: '2026-08-23',
      goal: null,
      gitSummary: GIT_OK,
      memoryWork: '工作摘要',
      memoryRelationship: '共享用户记忆与当前角色记忆',
      narrativeRecall: '剧情检索结果',
      taskReminder: '任务提醒',
      scratchpad: '已有文件：a.txt',
      subagents: [{ id: 'agent-1', title: '调查', description: '查调用链' }],
    });
    const order = [
      '## 当前日期',
      '## Git 状态',
      '## Work 记忆摘要',
      '## Relationship 记忆',
      '## Narrative 检索结果',
      '## 任务提醒',
      '## Scratchpad',
      '## 本 Session 子代理目录',
      '## Goal',
    ];
    const positions = order.map(marker => text.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('前 10 个保留 ID/完整 Title/description 前 50 字符, 其余全部只有 ID', () => {
    const subagents = Array.from({ length: 251 }, (_, index) => ({
      id: `agent-${index}`, title: `标题-${index}-${'题'.repeat(70)}`,
      description: `描述-${index}-` + '文'.repeat(80),
    }));
    const originals = subagents.map(subagent => subagent.description);
    const text = renderTurnReminder({ currentDate: '2026-10-03', goal: null, subagents });
    const lines = text.split('## 本 Session 子代理目录\n')[1]!.split('\n\n## Goal')[0]!.split('\n');
    expect(lines).toHaveLength(251);
    for (let index = 0; index < 10; index++) {
      expect(JSON.parse(lines[index]!)).toEqual({
        id: subagents[index]!.id, title: subagents[index]!.title,
        description: subagents[index]!.description.slice(0, 50),
      });
    }
    expect(lines.slice(10)).toEqual(subagents.slice(10).map(subagent => subagent.id));
    expect(subagents.map(subagent => subagent.description)).toEqual(originals);
  });

  it('description 按字符截断, 空值和换行不改变目录行数', () => {
    const text = renderTurnReminder({
      currentDate: '2026-10-03', goal: null,
      subagents: [
        { id: 'emoji', title: '多行\n标题', description: '😀'.repeat(51) },
        { id: 'empty', title: null, description: null },
        { id: 'short', title: '短说明', description: '原文\n 保留空格 ' },
      ],
    });
    const lines = text.split('## 本 Session 子代理目录\n')[1]!.split('\n\n## Goal')[0]!.split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ id: 'emoji', title: '多行\n标题', description: '😀'.repeat(50) });
    expect(JSON.parse(lines[1]!)).toEqual({ id: 'empty', title: null, description: '' });
    expect(JSON.parse(lines[2]!).description).toBe('原文\n 保留空格 ');
    expect(renderTurnReminder({ currentDate: '2026-10-03', goal: null, subagents: [] }))
      .not.toContain('## 本 Session 子代理目录');
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
    expect(text).toContain('逐项核对交付物, 测试, 验收条件和必须保持的约束');
    expect(text).toContain('仍有未满足或不确定项时继续工作');
    expect(text).toContain('feedback 中简要记录验证依据和覆盖结果');
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
