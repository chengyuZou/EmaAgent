// 展示当前 Session 的热尾或旧历史窗口，并连接 TurnRail 快速导航。
import { useRef, useEffect, useMemo, type JSX } from 'react';
import { Button } from '@ema-agent/ui';

import { useConversationStore, type ChatHistoryItem } from '../../stores/conversation-store.js';
import { useChatHistoryScroll } from './useChatHistoryScroll.js';
import { UserBubble } from '../messages/UserBubble.js';
import { AssistantBubble } from '../messages/AssistantBubble.js';
import {
  EMPTY_SESSION_HISTORY,
  useSessionHistoryStore,
} from './sessionHistoryStore.js';
import { TurnRail } from './TurnRail.js';

const EMPTY_MSGS: ChatHistoryItem[] = [];

export function ChatHistory(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const viewedId  = useConversationStore((s) => s.viewedSessionId);
  const messages  = useConversationStore((s) =>
    viewedId ? (s.messages.get(viewedId as string) ?? EMPTY_MSGS) : EMPTY_MSGS,
  );
  const streaming = useConversationStore((s) =>
    viewedId ? s.streamingMap.get(viewedId as string) ?? null : null,
  );
  const stopReason = useConversationStore((s) =>
    viewedId ? s.stopReasonMap.get(viewedId as string) ?? null : null,
  );
  const sessionHistory = useSessionHistoryStore((state) =>
    viewedId
      ? state.bySession.get(viewedId as string) ?? EMPTY_SESSION_HISTORY
      : EMPTY_SESSION_HISTORY,
  );
  const archiveWindow = useMemo(
    () => sessionHistory.archiveWindows.find(
      (window) => window.anchorTurnId === sessionHistory.activeArchiveTurnId,
    ),
    [sessionHistory.activeArchiveTurnId, sessionHistory.archiveWindows],
  );
  const displayedMessages = sessionHistory.mode === 'archive' && archiveWindow
    ? archiveWindow.messages
    : messages;
  const displayedStreaming = sessionHistory.mode === 'tail' ? streaming : null;

  useEffect(() => {
    if (!viewedId) return;
    void useConversationStore.getState().loadMessages(viewedId);
  }, [viewedId]);

  const scrollToTurnId = useConversationStore((s) => s.scrollToTurnId);

  useEffect(() => {
    if (!scrollToTurnId || !containerRef.current) return;
    const target = displayedMessages.find((m) => m.turnId === scrollToTurnId);
    if (!target) return;
    const key = target.messageId ?? `${target.role}:${target.createdAt}:${displayedMessages.indexOf(target)}`;
    const el = containerRef.current.querySelector(`#msg-${CSS.escape(key)}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    useConversationStore.setState({ scrollToTurnId: null });
  }, [displayedMessages, scrollToTurnId]);

  const { userScrolled, resetUserScrolled } = useChatHistoryScroll(
    containerRef,
    [displayedMessages, displayedStreaming],
    [viewedId],
  );
  let lastUserIndex = -1;
  const lastAssistantIndexByTurn = new Map<string, number>();
  for (let index = displayedMessages.length - 1; index >= 0; index--) {
    const message = displayedMessages[index];
    if (message?.role === 'assistant' && message.turnId && !lastAssistantIndexByTurn.has(message.turnId)) {
      lastAssistantIndexByTurn.set(message.turnId, index);
    }
    if (lastUserIndex < 0 && message?.role === 'user') {
      lastUserIndex = index;
    }
  }

  useEffect(() => {
    const root = containerRef.current;
    if (!root || !viewedId) return;
    const visibility = new Map<Element, IntersectionObserverEntry>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) visibility.set(entry.target, entry);
      const visible = [...visibility.values()]
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => (
          Math.abs(left.boundingClientRect.top - root.getBoundingClientRect().top)
          - Math.abs(right.boundingClientRect.top - root.getBoundingClientRect().top)
        ))[0];
      const turnId = visible?.target.getAttribute('data-turn-id');
      if (turnId) {
        useSessionHistoryStore.getState().setCurrentTurn(viewedId, turnId);
      }
    }, { root, threshold: 0.15 });
    const targets = root.querySelectorAll('[data-turn-id]');
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [displayedMessages, displayedStreaming, viewedId]);

  async function selectTurn(turnId: string): Promise<void> {
    if (!viewedId) return;
    const inTail = messages.some((message) => message.turnId === turnId);
    if (inTail) {
      useSessionHistoryStore.getState().showTail(viewedId);
      requestAnimationFrame(() => {
        useConversationStore.getState().scrollToTurn(turnId);
      });
      return;
    }
    await useSessionHistoryStore.getState().openArchive(viewedId, turnId);
    const latest = useSessionHistoryStore.getState().bySession.get(viewedId as string);
    if (latest?.mode === 'archive' && latest.activeArchiveTurnId === turnId) {
      requestAnimationFrame(() => {
        useConversationStore.getState().scrollToTurn(turnId);
      });
    }
  }

  function returnToTail(): void {
    if (!viewedId) return;
    useSessionHistoryStore.getState().showTail(viewedId);
    requestAnimationFrame(resetUserScrolled);
  }

  if (!viewedId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm ema-slide-up text-[var(--ema-text-tertiary)] ema-bubble-corner">
        选择或创建会话开始聊天
      </div>
    );
  }

  return (
    <div className="flex-1 relative ema-fade-mask-top">
      <TurnRail sessionId={viewedId} onSelectTurn={selectTurn} />
      <div ref={containerRef} className="absolute inset-0 overflow-y-auto py-4 pl-14 pr-4">
        {displayedMessages.length === 0 && !displayedStreaming && (
          <div className="flex items-center justify-center h-full text-sm ema-slide-up text-[var(--ema-text-tertiary)]">
            开始聊天吧
          </div>
        )}

        <div className="flex flex-col gap-2 max-w-2xl mx-auto">
          {displayedMessages.map((msg, i) => {
            const key = getKey(msg, i);
            const isLastUserMessage = msg.role === 'user' && i === lastUserIndex;
            const isFinalAssistantForTurn = msg.role === 'assistant'
              && !!msg.turnId
              && lastAssistantIndexByTurn.get(msg.turnId) === i;
            return (
              <div key={key} id={`msg-${key}`} data-turn-id={msg.turnId}>
                <BubbleRouter
                  message={msg}
                  canEditUser={sessionHistory.mode === 'tail' && isLastUserMessage && !streaming}
                  canForkAssistant={sessionHistory.mode === 'tail' && isFinalAssistantForTurn}
                />
              </div>
            );
          })}

          {displayedStreaming && (
            <div data-turn-id={displayedStreaming.turnId}>
              <AssistantBubble
                message={{
                  content: displayedStreaming.content,
                  slices: displayedStreaming.slices,
                  createdAt: displayedStreaming.startedAt,
                  turnId: displayedStreaming.turnId,
                  executionProfile: displayedStreaming.executionProfile,
                  narrativePolicy: displayedStreaming.narrativePolicy,
                }}
                isStreaming
              />
            </div>
          )}

          {sessionHistory.mode === 'tail' && stopReason && !streaming && (
            <div className="flex justify-center">
              <div className="ema-slide-up rounded-full px-4 py-1.5 text-xs bg-[var(--ema-surface-2)] text-[var(--ema-text-tertiary)]"
                   style={{ border: '1px solid var(--ema-border)' }}>
                {stopReason}
              </div>
            </div>
          )}
        </div>
      </div>

      {sessionHistory.archiveLoading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--ema-mask)] text-xs text-[var(--ema-text-tertiary)]">
          正在读取历史窗口…
        </div>
      )}

      {sessionHistory.mode === 'archive' && (
        <Button
          variant="ghost"
          className="ema-slide-up absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-[var(--ema-border)] bg-[var(--ema-surface-2)] px-3 py-1.5 text-xs text-[var(--ema-text-secondary)] shadow-lg hover:bg-[var(--ema-surface-3)]"
          onClick={returnToTail}
        >
          <span className="i-lucide:arrow-down mr-1 text-xs align-middle" aria-hidden />
          {sessionHistory.unseenTailCount > 0
            ? `${sessionHistory.unseenTailCount} 条新回复 · 回到最新`
            : '回到最新'}
        </Button>
      )}

      {sessionHistory.mode === 'tail' && userScrolled && (
        <Button
          variant="ghost"
          className="ema-slide-up absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-xs transition-colors shadow-lg bg-[var(--ema-surface-2)] hover:bg-[var(--ema-surface-3)] border border-[var(--ema-border)] text-[var(--ema-text-secondary)]"
          onClick={resetUserScrolled}
        >
          <span className="i-lucide:arrow-down text-xs mr-1 align-middle" aria-hidden />回到底部
        </Button>
      )}
    </div>
  );
}

// ── Internal ──────────────────────────────────────────────────────────────────

function BubbleRouter({
  message,
  canEditUser = false,
  canForkAssistant = false,
}: {
  message: ChatHistoryItem;
  canEditUser?: boolean;
  canForkAssistant?: boolean;
}): JSX.Element {
  switch (message.role) {
    case 'user':      return <UserBubble message={message} canEdit={canEditUser} />;
    case 'assistant': return <AssistantBubble message={message} canFork={canForkAssistant} />;
    case 'system':
      return (
        <div className="flex items-center justify-center gap-3 py-2">
          <div className="flex-1 border-t border-[var(--ema-border)]" />
          <span className="text-xs whitespace-nowrap text-[var(--ema-text-tertiary)]">{message.content}</span>
          <div className="flex-1 border-t border-[var(--ema-border)]" />
        </div>
      );
    case 'error':
      return (
        <div className="flex justify-center">
          <div className="rounded-xl px-4 py-2 text-sm max-w-md bg-[var(--ema-danger-muted)] text-[var(--ema-danger-text)]"
               style={{ border: '1px solid var(--ema-danger)' }}>
            {message.content}
          </div>
        </div>
      );
    default:
      return <div className="text-xs text-center text-[var(--ema-text-tertiary)]">{message.content}</div>;
  }
}

function getKey(msg: ChatHistoryItem, index: number): string {
  return msg.messageId ?? `${msg.role}:${msg.createdAt}:${index}`;
}
