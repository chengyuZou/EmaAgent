/**
 * ChatHistory — scrollable message list with auto-scroll-to-bottom.
 *
 * Uses native <div> (NOT ScrollArea) because useChatHistoryScroll needs
 * direct ref to the scrollable container.
 */
import { useRef, useEffect, type JSX } from 'react';
import { useChatStore, type ChatHistoryItem } from '../stores/chat-store.js';
import { useChatHistoryScroll } from './use-chat-history-scroll.js';
import { UserBubble } from './UserBubble.js';
import { AssistantBubble } from './AssistantBubble.js';

export function ChatHistory(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeId = useChatStore((s) => s.activeSessionId);
  const messages = useChatStore((s) => (activeId ? s.messages.get(activeId as string) ?? [] : []));
  const streaming = useChatStore((s) => s.streamingMessage);

  // Load messages when switching sessions (selectSession triggers listMessages internally)
  useEffect(() => {
    if (!activeId) return;
    const store = useChatStore.getState();
    if (!store.messages.has(activeId as string)) {
      void store.selectSession(activeId);
    }
  }, [activeId]);

  const { userScrolled, resetUserScrolled } = useChatHistoryScroll(
    containerRef,
    [messages, streaming],
  );

  if (!activeId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        选择或创建会话开始聊天
      </div>
    );
  }

  return (
    <div className="flex-1 relative">
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 && !streaming && (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            开始聊天吧
          </div>
        )}

        <div className="flex flex-col gap-4 max-w-2xl mx-auto">
          {messages.map((msg, i) => (
            <BubbleRouter key={getKey(msg, i)} message={msg} />
          ))}

          {/* Streaming message */}
          {streaming && (
            <AssistantBubble
              message={{
                content: streaming.content,
                slices: streaming.slices,
                createdAt: streaming.startedAt,
              }}
              isStreaming
            />
          )}
        </div>
      </div>

      {/* Scroll-to-bottom button */}
      {userScrolled && (
        <button
          className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-gray-800 border border-gray-600 text-gray-300 text-xs hover:bg-gray-700 transition-colors shadow-lg"
          onClick={resetUserScrolled}
        >
          ⬇ 回到底部
        </button>
      )}
    </div>
  );
}

/** Route a ChatHistoryItem to the correct bubble component. */
function BubbleRouter({ message }: { message: ChatHistoryItem }): JSX.Element {
  switch (message.role) {
    case 'user':
      return <UserBubble message={message} />;
    case 'assistant':
      return <AssistantBubble message={message} />;
    case 'error':
      return (
        <div className="flex justify-center">
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-2 text-sm text-red-300 max-w-md">
            {message.content}
          </div>
        </div>
      );
    default:
      return <div className="text-gray-500 text-xs text-center">{message.content}</div>;
  }
}

function getKey(msg: ChatHistoryItem, index: number): string {
  return msg.messageId ?? `${msg.role}:${msg.createdAt}:${index}`;
}
