/** UserBubble — right-aligned user message. Layout from AIRI user-item.vue, colors original. */
import type { JSX } from 'react';
import { Markdown } from '../markdown/renderer.js';
import type { ChatHistoryItem } from '../stores/conversation-store.js';
import { AttachmentChip } from './AttachmentChip.js';

export interface UserBubbleProps {
  message: ChatHistoryItem;
  label?:  string;
}

export function UserBubble({ message, label = '你' }: UserBubbleProps): JSX.Element {
  const attachments = message.attachments ?? [];

  return (
    <div className="flex ml-12 flex-row-reverse">
      <div className="flex flex-col min-w-20 max-w-full items-end">
        <div className="text-xs text-white/50 font-normal mb-1">{label}</div>

        {/* Attachment chips — shown above the message bubble when present */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 mb-1.5 max-w-full">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} />
            ))}
          </div>
        )}

        <div className="bg-neutral-800/80 backdrop-blur-sm border border-neutral-700/40 rounded-2xl rounded-br-md px-5 py-3 text-sm text-neutral-200 break-words">
          <Markdown source={message.content} />
        </div>
      </div>
    </div>
  );
}
