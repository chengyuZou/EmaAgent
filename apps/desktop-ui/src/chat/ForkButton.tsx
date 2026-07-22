/**
 * ForkButton — 消息气泡底部的"从此处分叉新分支"入口。
 *
 * F-052: 点击只标记分叉点(armFork), 不立即创建空分支;
 * 发送下一条消息时才真正 fork 并把新 turn 落到新分支上。
 *
 * 视觉：默认隐入（opacity-30），hover 显出（opacity-80），与 AssistantBubble 的 replay 按钮风格一致。
 * 用 @ema-agent/ui 的 IconButton（禁 raw <button>）。
 * streaming 气泡不显示（分支是完成态操作）；无 viewedId 返回 null。
 */
import type { JSX } from 'react';
import { IconButton } from '@ema-agent/ui';
import type { TurnId } from '@ema-agent/ids';
import { useConversationStore } from '../stores/conversation-store.js';
import { showToast } from '../lib/toast.js';

export function ForkButton({ turnId }: { turnId: string }): JSX.Element | null {
  const viewedId = useConversationStore((s) => s.viewedSessionId);
  if (!viewedId) return null;

  const handleFork = (): void => {
    useConversationStore.getState().armFork(turnId as TurnId);
    showToast('已标记分叉点，发送消息即创建新分支');
  };

  return (
    <IconButton
      variant="default"
      size="sm"
      icon="i-lucide:git-fork"
      label="从此处分叉新分支"
      className="opacity-30 hover:opacity-80 -ml-0.5"
      onClick={handleFork}
    />
  );
}
