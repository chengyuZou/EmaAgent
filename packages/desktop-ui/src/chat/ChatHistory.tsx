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
  const iterationCount = useConversationStore((s) =>
    viewedId ? s.iterationCountMap.get(viewedId as string) ?? null : null,
  );

  useEffect(() => {
    if (!viewedId) return;
    void useConversationStore.getState().loadMessages(viewedId);
  }, [viewedId]);

  const { userScrolled, resetUserScrolled } = useChatHistoryScroll(
    containerRef,
    [messages, streaming],
    [viewedId],
  );

  if (!viewedId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        选择或创建会话开始聊天
      </div>
    );
  }

  return (
    <div className="flex-1 relative">
      <div ref={containerRef} className="absolute inset-0 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !streaming && (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            开始聊天吧
          </div>
        )}

        <div className="flex flex-col gap-2 max-w-2xl mx-auto">
          {messages.map((msg, i) => (
            <BubbleRouter key={getKey(msg, i)} message={msg} />
          ))}

          {streaming && (
            <AssistantBubble
              message={{ content: streaming.content, slices: streaming.slices, createdAt: streaming.startedAt }}
              isStreaming
              iterationCount={iterationCount ?? undefined}
            />
          )}

          {stopReason && !streaming && (
            <div className="flex justify-center">
              <div className="bg-gray-800/80 border border-gray-600/50 rounded-full px-4 py-1.5 text-xs text-gray-400">
                {stopReason}
              </div>
            </div>
          )}
        </div>
      </div>

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

function BubbleRouter({ message }: { message: ChatHistoryItem }): JSX.Element {
  switch (message.role) {
    case 'user':      return <UserBubble message={message} />;
    case 'assistant': return <AssistantBubble message={message} />;
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
