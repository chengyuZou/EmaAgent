/** UserBubble — right-aligned user message. Layout from AIRI user-item.vue, colors original. */
import type { JSX } from 'react';
import { Markdown } from '../markdown/renderer.js';
import type { ChatHistoryItem } from '../stores/conversation-store.js';
import { AttachmentChip } from './AttachmentChip.js';

export interface UserBubbleProps {
  message: ChatHistoryItem;
  label?:  string;
}

export function UserBubble({ message }: UserBubbleProps): JSX.Element {
  const attachments = message.attachments ?? [];

  return (
    <div className="flex ml-12 flex-row-reverse ema-bubble-in">
      <div className="flex flex-col min-w-20 max-w-full items-end">
        {/* Attachment chips — shown above the message bubble when present */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 mb-1.5 max-w-full">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} />
            ))}
          </div>
        )}

        <div className="rounded-2xl rounded-br-md px-5 py-3 border text-sm break-words"
             style={{ background: 'var(--ema-surface-2)', borderColor: 'var(--ema-border)', color: 'var(--ema-text-secondary)' }}>
          <Markdown source={message.content} />
        </div>
      </div>
    </div>
  );
}
