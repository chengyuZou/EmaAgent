import type { GitSummary } from '@ema-agent/git';

export interface RenderTurnReminderInput {
  /** 调用方冻结的日期文本 */
  readonly currentDate: string;
  /** Work 模式的 Git 初始状态 */
  readonly gitSummary?: GitSummary;
  /** Work memory_summary.md 的本轮摘要 */
  readonly memoryWork?: string;
  /** 共享用户记忆, 当前角色记忆与相关角色关系的本轮正式文本 */
  readonly memoryRelationship?: string;
  /** NarrativePolicy='always' 时对本 Turn 用户输入的一次剧情检索结果 */
  readonly narrativeRecall?: string;
  /** Task 包的低频提醒 宿主在 reminder 落库成功后显式提交"已提醒" */
  readonly taskReminder?: string;
  /** Turn 开始时已存在的 Scratchpad 摘要 */
  readonly scratchpad?: string;
}

export function renderTurnReminder(input: RenderTurnReminderInput): string {
  const sections: string[] = [`## 当前日期\n${input.currentDate}`];

  const git = renderGitSummary(input.gitSummary);
  if (git) sections.push(`## Git 状态(本次开始时)\n${git}`);
  if (input.memoryWork?.trim()) {
    sections.push(`## Work 记忆摘要\n${input.memoryWork.trim()}`);
  }
  if (input.memoryRelationship?.trim()) {
    sections.push(`## Relationship 记忆\n${input.memoryRelationship.trim()}`);
  }
  if (input.narrativeRecall?.trim()) {
    sections.push(`## Narrative 检索结果\n${input.narrativeRecall.trim()}`);
  }

  if (input.taskReminder?.trim()) {
    sections.push(`## 任务提醒\n${input.taskReminder.trim()}`);
  }
  if (input.scratchpad?.trim()) {
    sections.push(`## Scratchpad\n${input.scratchpad.trim()}`);
  }

  return [
    '<system-reminder>',
    '以下内容反映本 Turn 开始时的状态. 后续 Tool Result 可能使文件 Git 任务或其他状态发生变化; 发生冲突时, 以本 Turn 中更新更晚的 Tool Result 为准.不要向用户复述本提醒.',
    ...sections,
    '</system-reminder>',
  ].join('\n\n');
}

function renderGitSummary(summary: GitSummary | undefined): string | undefined {
  if (!summary || summary.capability !== 'ok') return undefined;

  const head = summary.branch
    ? `分支: ${summary.branch}`
    : `Detached HEAD: ${summary.headShortSha ?? 'unknown'}`;
  const lines = [
    `仓库: ${summary.repoRoot}`,
    head,
    `未暂存: ${formatChangeStats(summary.unstaged)}`,
    `已暂存: ${formatChangeStats(summary.staged)}`,
    `未跟踪文件: ${summary.untrackedCount}`,
  ];
  if (summary.upstream) lines.push(`上游: ${summary.upstream}`);
  return lines.join('\n');
}

function formatChangeStats(stats: { filesChanged: number; insertions: number; deletions: number }): string {
  return `${stats.filesChanged} 个文件, +${stats.insertions} / -${stats.deletions}`;
}
