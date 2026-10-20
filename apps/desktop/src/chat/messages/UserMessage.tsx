import { useState, type JSX } from 'react';
import { Button, IconButton, Markdown, Tooltip } from '@ema-agent/ui';
import type { Message, MessageBlocks, SessionUserBlock } from '@ema-agent/session';
import { formatTurnTime } from './toolBlocks/toolGroups.js';
import { sessionSourceTab, useSessionPanelStore } from '../../stores/sessionPanel.js';
import { AttachmentImagePreview } from '../../lib/images/attachmentImagePreview.js';
import { ImagePreview } from '../../lib/images/imagePreview.js';
import { AttachmentGroup } from '../attachments/attachmentGroup.js';
import { attachmentLabel } from '../attachments/attachmentLabel.js';

export interface UserMessageProps {
  readonly message: Pick<Message, 'blocks' | 'createdAt'>;
  readonly sessionId: string;
  readonly pending?: boolean;
}

export function UserMessage({ message, sessionId, pending = false }: UserMessageProps): JSX.Element {
  const content = messageText(message);
  const images = Array.isArray(message.blocks)
    ? message.blocks.filter(
      (block): block is Extract<SessionUserBlock, { type: 'image_reference' | 'image_data' | 'image_url' }> =>
        block.type === 'image_reference'
        || block.type === 'image_data'
        || block.type === 'image_url',
    )
    : [];
  const references = Array.isArray(message.blocks)
    ? message.blocks.filter(
      (block): block is Extract<SessionUserBlock, { type: 'pasted_text_reference' | 'file_reference' | 'skill_reference' }> =>
        block.type === 'pasted_text_reference'
        || block.type === 'file_reference'
        || block.type === 'skill_reference',
    )
    : [];
  const segments = Array.isArray(message.blocks)
    ? message.blocks.filter(
      (block): block is Extract<SessionUserBlock, { type: 'text' }> => block.type === 'text',
    )
    : [{ type: 'text' as const, text: content }];

  const [copied, setCopied] = useState(false);

  const copyContent = (): void => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    });
  };

  return (
    <div className="ema-message-shell flex flex-row-reverse">
      <div className="ema-user-message">
        {images.length > 0 && (
          <AttachmentGroup label="图片">
            {images.map((block, index) => {
              if (block.type === 'image_reference') {
                return (
                  <AttachmentImagePreview
                    key={`${block.path}-${index}`}
                    sessionId={sessionId}
                    path={block.path}
                    alt={block.name ?? '剪贴板图片'}
                    className="ema-image-preview--attachment"
                  />
                );
              }
              if (block.type === 'image_data') {
                return (
                  <ImagePreview
                    key={`image-data-${index}`}
                    src={`data:${block.mimeType};base64,${block.data}`}
                    alt={block.name ?? '图片'}
                    className="ema-image-preview--attachment"
                  />
                );
              }
              return (
                <ImagePreview
                  key={`${block.url}-${index}`}
                  src={block.url}
                  alt={block.name ?? '图片'}
                  className="ema-image-preview--attachment"
                />
              );
            })}
          </AttachmentGroup>
        )}
        {references.length > 0 && (
          <AttachmentGroup label="附件">
            {references.map((block, index) => {
              const display = attachmentLabel(block);
              const label = (
                <>
                  <span className={display.icon} style={{ color: display.color }} aria-hidden />
                  <span className="ema-attachment-chip-label">{display.label}</span>
                </>
              );
              // 文件和 Skill 只显示引用, 粘贴文本沿用现有附件面板入口.
              return (
                <Tooltip key={`${block.type}-${block.path}-${index}`} content={display.detail} variant="card">
                  {block.type === 'pasted_text_reference' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ema-attachment-chip"
                      onClick={() => useSessionPanelStore.getState().openTab(sessionId, sessionSourceTab(block.path))}
                    >
                      {label}
                    </Button>
                  ) : (
                    <span className="ema-attachment-chip" tabIndex={0}>{label}</span>
                  )}
                </Tooltip>
              );
            })}
          </AttachmentGroup>
        )}

        {content.trim().length > 0 && (
          <div className="ema-message-content rounded-2xl rounded-br-md px-5 py-3 border text-sm bg-[var(--ema-surface-2)] border-[var(--ema-border)] text-[var(--ema-text-secondary)]">
            {segments.map((segment, index) => (
              <span key={`text-${index}`} className="ema-md-inline">
                <Markdown source={segment.text} />
              </span>
            ))}
          </div>
        )}

        {pending && (
          <div role="status" className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--ema-text-tertiary)]">
            <span className="i-lucide:clock-3" aria-hidden />
            已提交, 等待处理
          </div>
        )}
        <div className="ema-message-footer ema-message-footer-user">
          <span className="ema-message-footer-stats tabular-nums">{formatTurnTime(message.createdAt)}</span>
          {content.trim().length > 0 && (
            <IconButton
              size="sm"
              variant="ghost"
              shape="rounded"
              icon={copied ? 'i-lucide:check' : 'i-lucide:copy'}
              label="复制"
              className="ema-chat-icon-btn chat-message-action"
              onClick={copyContent}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function messageText(message: { readonly blocks: MessageBlocks }): string {
  if (typeof message.blocks === 'string') {
    return message.blocks;
  }
  if (!Array.isArray(message.blocks)) {
    return '';
  }
  return message.blocks
    .filter((block): block is Extract<SessionUserBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('');
}

