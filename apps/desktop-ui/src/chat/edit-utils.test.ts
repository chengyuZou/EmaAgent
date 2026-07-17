// 测试编辑分叉的 fork 点查找: 优先取目标 turn 的前驱, 首个 turn 回退到
// active 分支的 forkFromTurnId, 整个会话首 turn 返回 null(隐藏编辑入口)。

import { describe, expect, it } from 'vitest';
import { findEditForkPoint } from './edit-utils.js';
import type { ChatHistoryItem } from '../stores/conversation-store.js';
import type { BranchTreeWire } from '../api/sessions.js';
import type { TurnId } from '@ema-agent/contracts';

function msg(turnId: string): ChatHistoryItem {
  return { role: 'user', content: 'x', createdAt: 1, turnId: turnId as TurnId };
}

function tree(activeForkFromTurnId: string | null): BranchTreeWire {
  return {
    sessionActiveBranchId: 'b1' as never,
    branches: [{
      branchId: 'b1' as never,
      parentBranchId: null,
      forkFromTurnId: activeForkFromTurnId as TurnId | null,
      forkUserInput: '',
      forkTurnMode: null,
      isActive: true,
      createdAt: 1,
    }],
    turns: [],
  };
}

describe('findEditForkPoint(编辑分叉 fork 点)', () => {
  it('目标 turn 有前驱时取最近一个不同 turn', () => {
    const messages = [msg('t1'), msg('t1-assistant-same-turn'), msg('t2')];
    // t2 的前驱: 跳过同一 turn 的消息, 取 t1
    expect(findEditForkPoint([msg('t1'), msg('t1'), msg('t2')], 't2', undefined)).toBe('t1');
    expect(messages.length).toBe(3);
  });

  it('目标是本分支首个 turn 时回退到 active 分支的 forkFromTurnId', () => {
    expect(findEditForkPoint([msg('t2')], 't2', tree('t1'))).toBe('t1');
  });

  it('整个会话的第一个 turn 返回 null(隐藏编辑入口)', () => {
    expect(findEditForkPoint([msg('t1')], 't1', tree(null))).toBeNull();
    expect(findEditForkPoint([], 't1', undefined)).toBeNull();
  });
});
