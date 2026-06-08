/** UserBubble — right-aligned user message. Layout from AIRI user-item.vue, colors original. */
import type { JSX } from 'react';
import { Markdown } from '../markdown/renderer.js';
import type { ChatHistoryItem } from '../stores/conversation-store.js';

export interface UserBubbleProps {
  message: ChatHistoryItem;
  label?:  string;
}

export function UserBubble({ message, label = '你' }: UserBubbleProps): JSX.Element {
  return (
    <div className="flex ml-12 flex-row-reverse">
      <div className="flex flex-col min-w-20 max-w-full">
        <div className="text-xs text-white/50 font-normal mb-1 text-right">{label}</div>
        <div className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-3 text-sm text-gray-200 break-words">
          <Markdown source={message.content} />
        </div>
      </div>
    </div>
  );
}
