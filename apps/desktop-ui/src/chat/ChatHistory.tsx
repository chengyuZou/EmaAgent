import { useRef, useEffect, type JSX } from 'react';
import { useConversationStore, type ChatHistoryItem } from '../stores/conversation-store.js';
import { useChatHistoryScroll } from './use-chat-history-scroll.js';
import { UserBubble } from './UserBubble.js';
import { AssistantBubble } from './AssistantBubble.js';

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
  const streamingMode = useConversationStore((s) =>
    viewedId ? s.streamingMap.get(viewedId as string)?.mode : undefined,
  );

  useEffect(() => {
    if (!viewedId) return;
    void useConversationStore.getState().loadMessages(viewedId);
  }, [viewedId]);

  const scrollToTurnId = useConversationStore((s) => s.scrollToTurnId);

  // Scroll to the first message belonging to the requested turn, then clear.
  useEffect(() => {
    if (!scrollToTurnId || !containerRef.current) return;
    const target = messages.find((m) => m.turnId === scrollToTurnId);
    if (!target) return;
    const key = target.messageId ?? `${target.role}:${target.createdAt}:${messages.indexOf(target)}`;
    const el = containerRef.current.querySelector(`#msg-${CSS.escape(key)}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    useConversationStore.setState({ scrollToTurnId: null }); // consume once
  }, [scrollToTurnId, messages]);

  const { userScrolled, resetUserScrolled } = useChatHistoryScroll(
    containerRef,
    [messages, streaming],
    [viewedId],
  );

  if (!viewedId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm ema-slide-up" style={{ color: 'var(--ema-text-tertiary)' }}>
        选择或创建会话开始聊天
      </div>
    );
  }

  return (
    <div className="flex-1 relative">
      <div ref={containerRef} className="absolute inset-0 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !streaming && (
          <div className="flex items-center justify-center h-full text-sm ema-slide-up" style={{ color: 'var(--ema-text-tertiary)' }}>
            开始聊天吧
          </div>
        )}

        <div className="flex flex-col gap-2 max-w-2xl mx-auto">
          {messages.map((msg, i) => {
            const key = getKey(msg, i);
            return (
              <div key={key} id={`msg-${key}`}>
                <BubbleRouter message={msg} />
              </div>
            );
          })}

          {streaming && (
            <AssistantBubble
              message={{ content: streaming.content, slices: streaming.slices, createdAt: streaming.startedAt, turnId: streaming.turnId, mode: streamingMode }}
              isStreaming
            />
          )}

          {stopReason && !streaming && (
            <div className="flex justify-center">
              <div className="ema-slide-up rounded-full px-4 py-1.5 text-xs"
                   style={{ background: 'var(--ema-surface-2)', border: '1px solid var(--ema-border)', color: 'var(--ema-text-tertiary)' }}>
                {stopReason}
              </div>
            </div>
          )}
        </div>
      </div>

      {userScrolled && (
        <button
          className="ema-slide-up absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-xs transition-colors shadow-lg"
          style={{ background: 'var(--ema-surface-2)', border: '1px solid var(--ema-border)', color: 'var(--ema-text-secondary)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ema-surface-3)'; }}
          onClick={resetUserScrolled}
        >
          ⬇ 回到底部
        </button>
      )}
    </div>
  );
}

// ── Internal ──────────────────────────────────────────────────────────────────

function BubbleRouter({ message }: { message: ChatHistoryItem }): JSX.Element {
  switch (message.role) {
    case 'user':      return <UserBubble message={message} />;
    case 'assistant': return <AssistantBubble message={message} />;
    case 'system':
      return (
        <div className="flex items-center justify-center gap-3 py-2">
          <div className="flex-1 border-t" style={{ borderColor: 'var(--ema-border)' }} />
          <span className="text-xs whitespace-nowrap" style={{ color: 'var(--ema-text-tertiary)' }}>{message.content}</span>
          <div className="flex-1 border-t" style={{ borderColor: 'var(--ema-border)' }} />
        </div>
      );
    case 'error':
      return (
        <div className="flex justify-center">
          <div className="rounded-xl px-4 py-2 text-sm max-w-md"
               style={{ background: 'var(--ema-danger-muted)', border: '1px solid var(--ema-danger)', color: 'var(--ema-danger-text)' }}>
            {message.content}
          </div>
        </div>
      );
    default:
      return <div className="text-xs text-center" style={{ color: 'var(--ema-text-tertiary)' }}>{message.content}</div>;
  }
}

function getKey(msg: ChatHistoryItem, index: number): string {
  return msg.messageId ?? `${msg.role}:${msg.createdAt}:${index}`;
}
