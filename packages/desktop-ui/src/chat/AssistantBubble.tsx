/**
 * AssistantBubble — left-aligned assistant message with slice-based rendering.
 *
 * Slices: text → Markdown, thinking → ThinkingBlock, tool_call → ToolCallBlock.
 * Also handles the streaming placeholder (empty content + slices).
 */
import { useMemo } from 'react';
import { Markdown } from '../markdown/renderer.js';
import { ThinkingBlock } from './ThinkingBlock.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import type { ChatHistoryItem, AssistantSlice } from '../stores/chat-store.js';

export interface AssistantBubbleProps {
  message:     Pick<ChatHistoryItem, 'content' | 'slices' | 'createdAt'>;
  label?:      string;
  isStreaming?: boolean;
}

export function AssistantBubble({ message, label = 'Ema', isStreaming }: AssistantBubbleProps): JSX.Element {
  const slices = useMemo(() => resolveSlices(message), [message]);

  const isEmpty = !message.content && (!slices || slices.length === 0);

  return (
    <div className="flex gap-3">
      {/* Avatar */}
      <div className="w-8 h-8 rounded-full bg-pink-400/20 flex items-center justify-center flex-shrink-0 mt-1">
        <span className="text-xs text-pink-300">E</span>
      </div>

      <div className="max-w-[80%] min-w-0">
        <div className="text-xs text-gray-500 mb-1">{label}</div>

        {isEmpty && isStreaming ? (
          <div className="bg-gray-800 border border-gray-700 rounded-2xl rounded-tl-md px-4 py-3">
            <div className="flex gap-1.5">
              <div className="w-2 h-2 rounded-full bg-gray-600 animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-2 h-2 rounded-full bg-gray-600 animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-2 h-2 rounded-full bg-gray-600 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        ) : (
          <div className="bg-gray-800 border border-gray-700 rounded-2xl rounded-tl-md px-4 py-3">
            {/* Render slices in order */}
            {slices && slices.length > 0 ? (
              slices.map((slice, i) => <SliceRenderer key={i} slice={slice} />)
            ) : (
              <Markdown source={message.content} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Resolve slices from message: if it has pre-parsed slices, use them; otherwise derive from content. */
function resolveSlices(msg: { content: string; slices?: AssistantSlice[] }): AssistantSlice[] {
  if (msg.slices && msg.slices.length > 0) return msg.slices;
  // Fallback: single text slice from content
  if (msg.content) return [{ type: 'text', text: msg.content }];
  return [];
}

function SliceRenderer({ slice }: { slice: AssistantSlice }): JSX.Element {
  switch (slice.type) {
    case 'text':
      return <Markdown source={slice.text ?? ''} />;
    case 'thinking':
      return <ThinkingBlock text={slice.text ?? ''} />;
    case 'tool_call':
      return <ToolCallBlock slice={slice as AssistantSlice & { type: 'tool_call' }} />;
    default:
      return <div className="text-xs text-gray-500">未知内容块</div>;
  }
}
