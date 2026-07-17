// 这里计算"编辑这条用户消息应该从哪个 turn 分叉"(编辑分叉的 fork 点查找)。

import type { ChatHistoryItem } from '../stores/conversation-store.js';
import type { BranchTreeWire } from '../api/sessions.js';
import type { TurnId } from '@ema-agent/contracts';

/**
 * 编辑 turn 的用户消息 = 从它前一个 turn 分叉, 再把编辑后的文本发成新分支的第一个 turn。
 *
 * 查找顺序:
 *   1. 当前线性历史(时间正序)中, 目标 turn 之前最近一个不同 turn 的 id;
 *   2. 目标已是本分支首个 turn 时, 回退到 active 分支的 forkFromTurnId(本分支的长出点);
 *   3. 都没有(整个会话的第一个 turn)返回 null——调用方应隐藏编辑入口。
 */
export function findEditForkPoint(
  messages: ChatHistoryItem[],
  turnId: string,
  branchTree: BranchTreeWire | undefined,
): TurnId | null {
  const idx = messages.findIndex(m => m.turnId === turnId);
  if (idx >= 0) {
    for (let j = idx - 1; j >= 0; j--) {
      const prev = messages[j]!.turnId;
      if (prev && prev !== turnId) return prev as TurnId;
    }
  }
  const active = branchTree?.branches.find(b => b.isActive);
  return (active?.forkFromTurnId ?? null) as TurnId | null;
}
