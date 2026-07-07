/**
 * ForkButton — 消息气泡底部的"从此处分叉新分支"入口。
 *
 * 点击调 sessionsApi.forkBranch(viewedId, turnId) —— 后端 forkMessage 已支持任意 fromTurnId，
 * 创建新空分支并切为 active。成功后 loadBranches + 清 messages + loadMessages 切到新分支。
 *
 * 视觉：默认隐入（opacity-30），hover 显出（opacity-80），与 AssistantBubble 的 replay 按钮风格一致。
 * 用 @ema-agent/ui 的 IconButton（禁 raw <button>）。
 *
 * streaming 气泡不显示（分支是完成态操作）；无 viewedId 返回 null。
 */
import type { JSX } from 'react';
import { IconButton } from '@ema-agent/ui';
import type { TurnId } from '@ema-agent/contracts';
import { useConversationStore } from '../stores/conversation-store.js';
import { sessionsApi } from '../api/sessions.js';
import { showToast } from '../lib/toast.js';

export function ForkButton({ turnId }: { turnId: string }): JSX.Element | null {
  const viewedId = useConversationStore((s) => s.viewedSessionId);
  if (!viewedId) return null;

  const handleFork = async (): Promise<void> => {
    try {
      await sessionsApi.forkBranch(viewedId, turnId as TurnId);
      // fork 后端已切到新分支 → 重载分支数据 + 消息
      await useConversationStore.getState().loadBranches(viewedId);
      useConversationStore.setState((s) => {
        const m = new Map(s.messages);
        m.delete(viewedId as string);
        return { messages: m };
      });
      await useConversationStore.getState().loadMessages(viewedId);
    } catch (err) {
      showToast(err instanceof Error ? `分叉失败: ${err.message}` : '分叉失败', { variant: 'danger' });
    }
  };

  return (
    <IconButton
      variant="default"
      size="sm"
      icon="i-mdi:source-fork"
      label="从此处分叉新分支"
      className="opacity-30 hover:opacity-80 -ml-0.5"
      onClick={() => void handleFork()}
    />
  );
}
