import type { Goal } from '@ema-agent/goal';
import type { TurnInputPart } from '../types.js';
import { renderGoalEditReminder } from '../reminder/turnReminder.js';
import type {
  PendingCompletionNotice,
  QueueMessage,
  QueuedSessionInput,
} from './queueTypes.js';

/** 只有没有排队用户输入时, 活跃 Goal 自动续接下一轮 Turn 才会使用这段提示词. */
export const GOAL_CONTINUATION_TEXT = '根据本轮 reminder 和 GoalGet 继续推进当前目标. '
  + '目标已暂停或关闭时不要继续历史目标, 不自行创建或激活目标.';

/** 队列内不同消息来源的枚举输入, 统一经 `buildQueueMessage` 转换为 QueueMessage. */
export type QueueMessageSource =
  | {
      readonly kind: 'user_inputs';
      readonly queuedInputs: readonly QueuedSessionInput[];
    }
  | {
      readonly kind: 'goal_edit';
      readonly goal: Goal;
    }
  | {
      readonly kind: 'completion_notices';
      readonly notices: readonly PendingCompletionNotice[];
    }
  | {
      readonly kind: 'goal_continue';
    };

/** 按提交顺序合并多条排队用户输入, 保持正文拼接与非文本附件的相对顺序. */
export function mergeQueuedInput(queuedInputs: readonly QueuedSessionInput[]): TurnInputPart[] {
  const mergedParts: TurnInputPart[] = [];
  for (const queuedInput of queuedInputs) {
    if (mergedParts.length > 0) {
      const previousPart = mergedParts.at(-1)!;
      if (previousPart.type === 'text') {
        mergedParts[mergedParts.length - 1] = { type: 'text', text: `${previousPart.text}\n\n` };
      } else {
        mergedParts.push({ type: 'text', text: '\n\n' });
      }
    }
    for (const part of queuedInput.input) {
      const previousPart = mergedParts.at(-1);
      if (previousPart?.type === 'text' && part.type === 'text') {
        mergedParts[mergedParts.length - 1] = { type: 'text', text: previousPart.text + part.text };
      } else {
        mergedParts.push(part);
      }
    }
  }
  return mergedParts;
}

/** 把多条后台终态整理成一条内部 continuation Message, 模型按需要自行调工具读取完整结果. */
export function formatCompletionNoticeText(notices: readonly PendingCompletionNotice[]): string {
  if (notices.length === 0) return '';
  const lines = notices.map(notice => notice.source === 'subagent_completed'
    ? `Subagent ${notice.subagentId} 已结束, status=${notice.status}. 如需完整结果, 调用 SubagentAwait.`
    : `BackgroundProcess ${notice.backgroundProcessId} 已结束, status=${notice.status}. 如需完整输出, 调用 ProcessOutput.`);
  return `以下后台工作已结束. 这里只通知身份与终态, 不代表结果已读:\n${lines.join('\n')}`;
}

/**
 * 把队列预留的来源转换成统一的 Turn 执行载荷 QueueMessage.
 * 普通用户输入直接生成 `'normal'`, 不再额外附带 Goal continuation 文本,
 * 因为 Turn 的 reminder 已经提供当前活跃 Goal 状态.
 */
export function buildQueueMessage(source: QueueMessageSource): QueueMessage {
  switch (source.kind) {
    case 'user_inputs':
      return {
        messageKind: 'normal',
        input: mergeQueuedInput(source.queuedInputs),
      };
    case 'goal_edit':
      return {
        messageKind: 'continuation',
        input: [{ type: 'text', text: renderGoalEditReminder(source.goal) }],
      };
    case 'completion_notices':
      return {
        messageKind: 'continuation',
        input: [{ type: 'text', text: formatCompletionNoticeText(source.notices) }],
      };
    case 'goal_continue':
      return {
        messageKind: 'continuation',
        input: [{ type: 'text', text: GOAL_CONTINUATION_TEXT }],
      };
  }
}
