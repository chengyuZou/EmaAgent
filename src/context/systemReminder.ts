// 把明确的运行时事实按固定顺序序列化为紧邻当前 Turn 的 system-reminder。
import type { GitSummary } from '@ema-agent/git';
import type { Message } from '@ema-agent/llm';
import type { ExecutionProfile } from '@ema-agent/turn';
import { ContextAssemblyError } from './errors.js';
import type { ContextReminder } from './types.js';

export type ReminderUsageKind =
  | 'runtimeContext'
  | 'memoryRecall'
  | 'narrativeRecall'
  | 'other';

export interface RenderedReminderSection {
  readonly kind: ReminderUsageKind;
  readonly content: string;
}

export interface RenderedSystemReminder {
  readonly message: Message;
  readonly sections: readonly RenderedReminderSection[];
}

export function renderSystemReminder(
  input: ContextReminder,
  executionProfile: ExecutionProfile,
): RenderedSystemReminder {
  if (!input.currentDate.trim()) {
    throw new ContextAssemblyError(
      'context/invalid-current-date',
      'Context reminder 的 currentDate 不能为空。',
    );
  }

  const sections: RenderedReminderSection[] = [
    section('runtimeContext', '当前日期', input.currentDate),
  ];
  if (executionProfile === 'work') {
    pushSection(sections, 'runtimeContext', 'Git 状态', renderGitSummary(input.gitSummary));
  }
  pushSection(sections, 'memoryRecall', 'Memory 召回', input.memoryRecall);
  pushSection(sections, 'narrativeRecall', 'Narrative 召回', input.narrativeRecall);
  pushSection(sections, 'other', '任务提醒', input.taskReminder);
  pushSection(sections, 'other', 'Scratchpad', input.scratchpad);

  return {
    message: {
      role: 'user',
      content: [
        '<system-reminder>',
        '以下内容是本次调用的运行时数据，不会覆盖 System Prompt，也不要向用户复述本提醒。',
        ...sections.map((item) => item.content),
        '</system-reminder>',
      ].join('\n\n'),
    },
    sections,
  };
}

function renderGitSummary(summary: GitSummary | undefined): string | undefined {
  if (!summary || summary.capability !== 'ok') return undefined;

  const head = summary.branch
    ? `分支：${summary.branch}`
    : `Detached HEAD：${summary.headShortSha ?? 'unknown'}`;
  const lines = [
    `仓库：${summary.repoRoot}`,
    head,
    `未暂存：${formatChangeStats(summary.unstaged)}`,
    `已暂存：${formatChangeStats(summary.staged)}`,
    `未跟踪文件：${summary.untrackedCount}`,
  ];
  if (summary.upstream) lines.push(`上游：${summary.upstream}`);
  return lines.join('\n');
}

function formatChangeStats(stats: { filesChanged: number; insertions: number; deletions: number }): string {
  return `${stats.filesChanged} 个文件，+${stats.insertions} / -${stats.deletions}`;
}

function pushSection(
  target: RenderedReminderSection[],
  kind: ReminderUsageKind,
  title: string,
  value: string | undefined,
): void {
  if (!value?.trim()) return;
  target.push(section(kind, title, value));
}

function section(
  kind: ReminderUsageKind,
  title: string,
  value: string,
): RenderedReminderSection {
  return {
    kind,
    content: `## ${title}\n${value.trim()}`,
  };
}
