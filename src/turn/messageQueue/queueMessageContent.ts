import type { Goal } from '@ema-agent/goal';
import { renderGoalEditReminder } from '../reminder/turnReminder.js';
import type {
  PendingCompletionNotice,
  QueueMessage,
  QueuedSessionInput,
} from './queueTypes.js';

/** 只有没有排队用户输入时, 活跃 Goal 自动续接下一轮 Turn 才会使用这段提示词. */
export const GOAL_CONTINUATION_TEXT = '根据本轮 reminder 和 GoalGet 继续推进当前目标. '
  + '目标已暂停或关闭时不要继续历史目标, 不自行创建或激活目标.';

/** 队列内不同消息来源的枚举输入, 统一经 `buildQueueMessages` 转换为 QueueMessage 列表. */
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

/** 把多条后台终态整理成一条内部 continuation Message, 模型按需要自行调工具读取完整结果. */
export function formatCompletionNoticeText(notices: readonly PendingCompletionNotice[]): string {
  if (notices.length === 0) return '';
  const lines = notices.map(notice => notice.source === 'subagent_completed'
    ? `Subagent ${notice.subagentId} 已结束, status=${notice.status}. 如需完整结果, 调用 SubagentAwait.`
    : `BackgroundProcess ${notice.backgroundProcessId} 已结束, status=${notice.status}. 如需完整输出, 调用 ProcessOutput.`);
  return `以下后台工作已结束. 这里只通知身份与终态, 不代表结果已读:\n${lines.join('\n')}`;
}

/**
 * 把队列预留的来源转换成待落库的 QueueMessage 列表.
 * 每条排队用户输入各自保持为一条 `'normal'` 消息, 不再合并正文, 由 Turn 事务逐行落库;
 * 内部续接通知与 Goal 编辑生成单条 `'continuation'` 消息.
 */
export function buildQueueMessages(source: QueueMessageSource): readonly QueueMessage[] {
  switch (source.kind) {
    case 'user_inputs':
      return source.queuedInputs.map(queuedInput => ({
        messageKind: 'normal',
        input: queuedInput.input,
      }));
    case 'goal_edit':
      return [{
        messageKind: 'continuation',
        input: [{ type: 'text', text: renderGoalEditReminder(source.goal) }],
      }];
    case 'completion_notices':
      return [{
        messageKind: 'continuation',
        input: [{ type: 'text', text: formatCompletionNoticeText(source.notices) }],
      }];
    case 'goal_continue':
      return [{
        messageKind: 'continuation',
        input: [{ type: 'text', text: GOAL_CONTINUATION_TEXT }],
      }];
  }
}
