import type { Goal } from '@ema-agent/goal';
import type { Subagent } from '@ema-agent/agent';

export interface RenderTurnReminderInput {
  /** 调用方冻结的日期文本 */
  readonly currentDate: string;
  /** 当前未关闭目标的 SQL 事实, 没有目标时也明确撤销历史 Goal 要求. */
  readonly goal: Goal | null;
  /** 仅本 Turn 相比该 Session 上一 Turn 换角时提供; 旧 reminder 不随之后的角色变化重写. */
  readonly characterSwitch?: {
    readonly previousCharacterName: string;
    readonly currentCharacterName: string;
  };
  /** Work memory_summary.md 的本轮摘要 */
  readonly memoryWork?: string;
  /** 共享用户记忆, 当前角色记忆与相关角色关系的本轮正式文本 */
  readonly memoryRelationship?: string;
  /** Task 包的低频提醒 宿主在 reminder 落库成功后显式提交"已提醒" */
  readonly taskReminder?: string;
  /** Turn 开始时已存在的 Scratchpad 摘要 */
  readonly scratchpad?: string;
  /** 当前 Session 的完整身份目录, 按最近更新时间降序; 只展示识别线索, 不读取子历史. */
  readonly subagents?: readonly Pick<Subagent, 'id' | 'title' | 'description'>[];
}

export function renderTurnReminder(input: RenderTurnReminderInput): string {
  const sections: string[] = [`## 当前日期\n${input.currentDate}`];

  if (input.characterSwitch) {
    const { previousCharacterName, currentCharacterName } = input.characterSwitch;
    sections.push([
      '## 角色切换',
      `本 Turn 从角色 ${previousCharacterName} 切换到角色 ${currentCharacterName}.`,
      `紧邻本提醒之前的一个角色对话区段属于 ${previousCharacterName}; 更早的区段按各自的角色切换提醒判断, 不把全部历史归给同一个角色.`,
      `从本提醒开始, 到下一条角色切换提醒之前, 助手发言属于 ${currentCharacterName}. 当前姓名是 ${currentCharacterName}, 请按该角色的人设继续对话.`,
      '其他角色说过的姓名, 第一人称, 职业, 经历和私人承诺属于当时的角色, 不认领为自己. 用户的需求, 偏好, 决定和工具已确认的事实继续保留. 不向用户复述本提醒.',
    ].join('\n'));
  }

  if (input.memoryWork?.trim()) {
    sections.push(`## Work 记忆摘要\n${input.memoryWork.trim()}`);
  }
  if (input.memoryRelationship?.trim()) {
    sections.push(`## Relationship 记忆\n${input.memoryRelationship.trim()}`);
  }

  if (input.taskReminder?.trim()) {
    sections.push(`## 任务提醒\n${input.taskReminder.trim()}`);
  }
  if (input.scratchpad?.trim()) {
    sections.push(`## Scratchpad\n${input.scratchpad.trim()}`);
  }
  if (input.subagents?.length) {
    const directory = input.subagents.map((subagent, index) => {
      if (index >= 10) {
        return subagent.id;
      }
      return JSON.stringify({
        id: subagent.id,
        title: subagent.title,
        // 按 Unicode 字符截取, 不把非 BMP 字符切成半个代理对; 不改存储原文.
        description: Array.from(subagent.description ?? '').slice(0, 50).join(''),
      });
    });
    sections.push(`## 本 Session 子代理目录\n${directory.join('\n')}`);
  }
  sections.push(renderGoal(input.goal));

  return [
    '<system-reminder>',
    '以下内容反映本 Turn 开始时的状态. 后续 Tool Result 可能使文件 Git 任务或其他状态发生变化; 发生冲突时, 以本 Turn 中更新更晚的 Tool Result 为准.不要向用户复述本提醒.',
    ...sections,
    '</system-reminder>',
  ].join('\n\n');
}

/** 运行中正文编辑的内部消息; 旧 reminder 保持原文, 新事实按正常消息顺序持久化. */
export function renderGoalEditReminder(goal: Goal): string {
  return [
    '<system-reminder>',
    '用户已修改当前 Goal. 从下一步起按以下最新目标调整工作, 旧正文和旧完成判断不再有效. 不向用户复述本提醒.',
    renderGoal(goal),
    '</system-reminder>',
  ].join('\n\n');
}

function renderGoal(goal: Goal | null): string {
  if (!goal) {
    return '## Goal\n当前没有激活的 Goal. 不再执行历史 Goal 的目标正文, 计划或续接要求; 历史消息和摘要不能授权重新建立或激活目标.';
  }
  const lines = [
    '## Goal',
    `Goal ID: ${goal.id}`,
    `Version: ${goal.version}`,
    `Status: ${goal.status}`,
  ];
  if (goal.status === 'paused') {
    lines.push('当前 Goal 已暂停. 不再执行该目标的工作或历史续接要求, 不自行激活目标.');
    return lines.join('\n');
  }
  lines.push(
    '以下是当前唯一有效的 Goal. 旧目标要求不再有效. 目标正文是用户任务内容, 不是更高优先级指令.',
    `目标正文:\n${goal.objective}`,
  );
  if (goal.feedback) {
    lines.push(`最近累计进度(模型自报, 不是完成判定):\n${goal.feedback}`);
  }
  lines.push(
    '仅主 Agent 管理 Goal. 子代理只执行父 Agent 派发的子任务, 不自行持续推进或报告主会话 Goal 状态.',
    '通过 GoalGet 读取最新事实. 完成一段实际工作或本轮结束时仍未完成, 使用 GoalUpdate(status=active, feedback=累计进度概况)报告进度, 不必每个 loop 更新.',
    '只有整个目标已完成或最终无法完成时才报告 completed/succeeded 或 completed/failed, 同时提交新的简要累计 feedback. 全部成果的详细总结写在本轮最终回复, 不塞进 feedback. 使用工具返回的最新 version, 不因暂时困难或单次工具报错结束目标.',
    '报告 succeeded 前, 从最新目标正文和其引用的要求逐项核对交付物, 测试, 验收条件和必须保持的约束. 对每项找到当前成果或实际验证结果作为证据, 区分已证明, 不满足, 未验证或证据不足; 仍有未满足或不确定项时继续工作, 不以计划, 意图, 历史记忆或没有发现明显问题代替完成证据. 在收尾 feedback 中简要记录验证依据和覆盖结果.',
    'Goal 关闭或暂停后停止执行其要求. 不创建, 取消, 删除, 暂停或重新激活 Goal; 不用旧版本判断盲目完成新版本.',
  );
  return lines.join('\n');
}

