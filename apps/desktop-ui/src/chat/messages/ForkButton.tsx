// 从一条已完成回复复制出独立 Session，并立即切换到新会话。
import type { JSX } from 'react';
import { IconButton } from '@ema-agent/ui';
import type { TurnId } from '@ema-agent/ids';
import { useConversationStore } from '../../stores/conversation-store.js';
import { useSessionStore } from '../../stores/session-store.js';
import { showToast } from '../../lib/toast.js';

export function ForkButton({ turnId }: { turnId: string }): JSX.Element | null {
  const viewedId = useConversationStore((s) => s.viewedSessionId);
  if (!viewedId) return null;

  const handleFork = async (): Promise<void> => {
    try {
      const newId = await useSessionStore
        .getState()
        .forkSession(viewedId, turnId as TurnId);
      await useConversationStore.getState().viewSession(newId);
      showToast('已从该回复创建新会话');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '创建新会话失败', { variant: 'danger' });
    }
  };

  return (
    <IconButton
      variant="default"
      size="sm"
      icon="i-lucide:git-fork"
      label="从该回复创建新会话"
      className="opacity-30 hover:opacity-80 -ml-0.5"
      onClick={() => void handleFork()}
    />
  );
}
