/**
 * AssistantBubble — left-aligned assistant message. Layout from AIRI assistant-item.vue,
 * colors kept as original EmaAgent gray.
 */
import type { JSX } from 'react';
import { Markdown } from '../markdown/renderer.js';
import { ThinkingBlock } from './ThinkingBlock.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import type { ChatHistoryItem, AssistantSlice } from '../stores/chat-store.js';

export interface AssistantBubbleProps {
  message:      Pick<ChatHistoryItem, 'content' | 'slices' | 'createdAt'>;
  label?:       string;
  isStreaming?: boolean;
}

export function AssistantBubble({ message, label = 'Ema', isStreaming }: AssistantBubbleProps): JSX.Element {
  const slices = resolveSlices(message);
  const isEmpty = slices.length === 0;

  return (
    <div className="flex mr-12">
      <div className="flex flex-col min-w-20 max-w-full">
        <div className="text-xs text-white/50 font-normal mb-1">{label}</div>

        {isEmpty && isStreaming ? (
          <div className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-3">
            <div className="flex gap-1.5 items-center h-4">
              <div className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        ) : (
          <div className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-gray-200 text-sm break-words flex flex-col gap-2">
            {slices.map((slice, i) => (
              <SliceRenderer key={i} slice={slice} streaming={!!isStreaming} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function resolveSlices(msg: { content: string; slices?: AssistantSlice[] }): AssistantSlice[] {
  if (msg.slices && msg.slices.length > 0) return msg.slices;
  if (msg.content) return [{ type: 'text', text: msg.content }];
  return [];
}

function SliceRenderer({ slice, streaming }: { slice: AssistantSlice; streaming: boolean }): JSX.Element {
  switch (slice.type) {
    case 'text':
      return <Markdown source={slice.text ?? ''} />;
    case 'thinking':
      return <ThinkingBlock text={slice.text ?? ''} />;
    case 'tool_call':
      return (
        <ToolCallBlock
          slice={slice as AssistantSlice & { type: 'tool_call' }}
          streaming={streaming}
        />
      );
    default:
      return <></>;
  }
}
