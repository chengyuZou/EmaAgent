import type { TurnInputPart } from '../types.js';
import type { QueuedSessionInput, CompletionNotice } from './continuationTypes.js';

export const GOAL_CONTINUATION_TEXT = '根据本轮 reminder 和 GoalGet 继续推进当前目标. '
  + '目标已暂停或关闭时不要继续历史目标, 不自行创建或激活目标.';

export function mergeQueuedInput(items: readonly QueuedSessionInput[]): TurnInputPart[] {
  const input: TurnInputPart[] = [];
  for (const item of items) {
    if (input.length > 0) {
      const last = input.at(-1)!;
      if (last.type === 'text') {
        input[input.length - 1] = { type: 'text', text: `${last.text}\n\n` };
      } else {
        input.push({ type: 'text', text: '\n\n' });
      }
    }
    for (const part of item.input) {
      const last = input.at(-1);
      if (last?.type === 'text' && part.type === 'text') {
        input[input.length - 1] = { type: 'text', text: last.text + part.text };
      } else {
        input.push(part);
      }
    }
  }
  return input;
}

/** 把多条后台终态整理成一条内部 continuation Message, 模型再按 ID 主动读取完整结果. */
export function formatCompletionNoticeText(notices: readonly CompletionNotice[]): string {
  if (notices.length === 0) return '';
  const lines = notices.map(notice => notice.kind === 'subagent'
    ? `Subagent ${notice.id} 已结束, status=${notice.status}. 如需完整结果, 调用 SubagentAwait.`
    : `BackgroundProcess ${notice.id} 已结束, status=${notice.status}. 如需完整输出, 调用 ProcessOutput.`);
  return `以下后台工作已结束. 这里只通知身份与终态, 不代表结果已读:\n${lines.join('\n')}`;
}
