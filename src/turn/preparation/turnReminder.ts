// 根 Turn 初始背景消息（kind='reminder'）的唯一文本构建位置。
// 只渲染 Turn 开始时已经取得的事实：本函数不读库、不读文件、不查模型、不看时钟；
// 何时落库、与用户消息的先后顺序、何时启动 AgentLoop 由 TurnExecutor 控制。
import type { GitSummary } from '@ema-agent/git';
import type { FrozenSelectedSkill } from './prepareTurn.js';

/** Turn 开始时由宿主读取一次的事实；空字段不进 reminder。 */
export interface TurnReminderFacts {
  /** Work 模式的 Git 初始状态。 */
  readonly gitSummary?: GitSummary;
  /** Work 轨 memory_summary.md 的本轮摘要（产出侧已按预算截断）。 */
  readonly memoryWork?: string;
  /** Relationship 轨 memory_summary.md 的本轮摘要（产出侧已按预算截断）。 */
  readonly memoryRelationship?: string;
  /** NarrativePolicy='always' 时对本 Turn 用户输入的一次剧情检索结果。 */
  readonly narrativeRecall?: string;
  /** Task 包的一次性低频提醒（take 语义，读取即消费）。 */
  readonly taskReminder?: string;
  /** Turn 开始时已存在的 Scratchpad 摘要。 */
  readonly scratchpad?: string;
}

export interface RenderTurnReminderInput {
  /** 调用方冻结的日期文本；本包不读取系统时钟。 */
  readonly currentDate: string;
  readonly facts: TurnReminderFacts;
  /** 本 Turn 显式选择的 Skill 正文（Turn 准备阶段冻结）。 */
  readonly selectedSkills: readonly FrozenSelectedSkill[];
}

/**
 * 渲染本 Turn 的初始背景。固定段序即缓存前缀序；Reminder 不是实时面板——
 * Tool 改了文件、Task 或 Scratchpad 后不回写本消息，模型从更新更晚的 Tool Result
 * 获得变化（开头声明写明这一点）。
 */
export function renderTurnReminder(input: RenderTurnReminderInput): string {
  const sections: string[] = [`## 当前日期\n${input.currentDate}`];
  const { facts } = input;

  const git = renderGitSummary(facts.gitSummary);
  if (git) sections.push(`## Git 状态（本 Turn 开始时）\n${git}`);
  if (facts.memoryWork?.trim()) {
    sections.push(`## Work 记忆摘要\n${facts.memoryWork.trim()}`);
  }
  if (facts.memoryRelationship?.trim()) {
    sections.push(`## Relationship 记忆摘要\n${facts.memoryRelationship.trim()}`);
  }
  if (facts.narrativeRecall?.trim()) {
    sections.push(`## Narrative 检索结果\n${facts.narrativeRecall.trim()}`);
  }

  // 多 Skill 按用户选择顺序注入；相同 SkillKey 去重。
  const seenSkills = new Set<string>();
  for (const skill of input.selectedSkills) {
    if (seenSkills.has(skill.key)) continue;
    seenSkills.add(skill.key);
    sections.push(`## 本 Turn 选用的技能：${skill.callName}\n${skill.content.trim()}`);
  }

  if (facts.taskReminder?.trim()) {
    sections.push(`## 任务提醒\n${facts.taskReminder.trim()}`);
  }
  if (facts.scratchpad?.trim()) {
    sections.push(`## Scratchpad\n${facts.scratchpad.trim()}`);
  }

  return [
    '<system-reminder>',
    '以下内容反映本 Turn 开始时的状态。后续 Tool Result 可能使文件、Git、任务或其他状态发生变化；发生冲突时，以本 Turn 中更新更晚的 Tool Result 为准。不要向用户复述本提醒。',
    ...sections,
    '</system-reminder>',
  ].join('\n\n');
}

/** 仓库摘要投影；originUrl 可能携带凭据，永不进入模型可见文本。 */
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
