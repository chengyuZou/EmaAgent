/** UserBubble — right-aligned user message. */
import { Markdown } from '../markdown/renderer.js';
import type { ChatHistoryItem } from '../stores/chat-store.js';

export interface UserBubbleProps {
  message: ChatHistoryItem;
  label?:  string;
}

export function UserBubble({ message, label = '你' }: UserBubbleProps): JSX.Element {
  return (
    <div className="flex justify-end">
      <div className="max-w-[75%]">
        <div className="text-xs text-gray-500 mb-1 text-right">{label}</div>
        <div className="bg-gray-800 border border-gray-700 rounded-2xl rounded-tr-md px-4 py-2.5 text-sm text-gray-200">
          <Markdown source={message.content} />
        </div>
      </div>
    </div>
  );
}
