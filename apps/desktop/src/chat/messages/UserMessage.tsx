// 渲染已经持久化的用户 Message. Skill 和附件使用 chip, text 使用公共 Markdown.
import { useState, type JSX } from 'react';
import { IconButton } from '@ema-agent/ui';

import { Markdown } from '@ema-agent/ui';
import type {
  AttachmentBlock,
  Message,
  MessageBlocks,
  SkillReferenceBlock,
  SessionUserBlock,
} from '@ema-agent/session';
import { useChatNavigationStore } from '../../stores/chatNavigation.js';
import { formatTurnTime } from './toolBlocks/toolGroups.js';
import {
  sessionSourceTab,
  useSessionPanelStore,
} from '../../stores/sessionPanel.js';

export interface UserMessageProps {
  message: Message;
}

export function UserMessage({ message }: UserMessageProps): JSX.Element {
  const content = messageText(message);
  // 附件卡置顶；正文按输入顺序走：text 段与 skill_reference chip 内联混排（用户放置的位置）。
  const attachments = Array.isArray(message.blocks)
    ? message.blocks.filter(
        (block): block is AttachmentBlock =>
          block.type === 'image_reference'
          || block.type === 'pasted_text_reference'
          || block.type === 'file_reference',
      )
    : [];
  const segments = Array.isArray(message.blocks)
    ? message.blocks.filter(
        (block): block is Extract<SessionUserBlock, { type: 'text' }> | SkillReferenceBlock =>
          block.type === 'text' || block.type === 'skill_reference',
      )
    : [{ type: 'text' as const, text: content }];

  const viewedId = useChatNavigationStore((s) => s.viewedSessionId);

  const [copied, setCopied] = useState(false);

  const copyContent = (): void => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    });
  };

  return (
    <div className="ema-message-shell flex ml-12 flex-row-reverse ema-bubble-in">
      <div className="flex flex-col min-w-20 max-w-full items-end">
        {attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 mb-1.5 max-w-full">
            {attachments.map((block) => {
              const chip = chipDisplay(block);
              // file_reference 无预览 image/pasted 点开预览 tab。
              const openable = block.type !== 'file_reference';
              return (
                <button
                  type="button"
                  key={block.path}
                  className={`ema-message-chip inline-flex items-center gap-1 border px-2 py-0.5 text-[11px] text-[var(--ema-text-tertiary)] ${
                    openable
                      ? 'hover:border-[var(--ema-border-strong)] hover:text-[var(--ema-text-primary)]'
                      : 'cursor-default'
                  }`}
                  onClick={() => {
                    if (openable && viewedId) {
                      useSessionPanelStore
                        .getState()
                        .openTab(viewedId, sessionSourceTab(block.path));
                    }
                  }}
                >
                  <span className={`${chip.icon} text-[10px]`} style={{ color: chip.color }} aria-hidden />
                  {chip.label}
                </button>
              );
            })}
          </div>
        )}

        {content.trim().length > 0 || segments.some((s) => s.type === 'skill_reference') ? (
          <div className="ema-message-content rounded-2xl rounded-br-md px-5 py-3 border text-sm bg-[var(--ema-surface-2)] border-[var(--ema-border)] text-[var(--ema-text-secondary)]">
            {segments.map((segment, index) =>
              segment.type === 'skill_reference' ? (
                <span
                  key={`skill-${segment.path}-${index}`}
                  className="ema-message-chip mx-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 align-baseline text-[11px] text-[var(--ema-text-secondary)]"
                >
                  <span className="i-lucide:sparkles text-[10px]" aria-hidden />
                  {segment.name}
                </span>
              ) : (
                <span key={`text-${index}`} className="ema-md-inline">
                  <Markdown source={segment.text} />
                </span>
              ),
            )}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-1.5 text-[11px] text-[var(--ema-text-tertiary)]">
          <span className="opacity-50 tabular-nums">{formatTurnTime(message.createdAt)}</span>
          {content.trim().length > 0 && (
            <IconButton
              size="sm"
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
  if (typeof message.blocks === 'string') return message.blocks;
  if (!Array.isArray(message.blocks)) return '';
  return message.blocks
    .filter((block): block is Extract<SessionUserBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('');
}

function chipDisplay(block: AttachmentBlock): { icon: string; color: string; label: string } {
  if (block.type === 'image_reference') {
    return { icon: 'i-mdi:image-outline', color: 'var(--ema-file-image)', label: block.name ?? '剪贴板图片' };
  }
  if (block.type === 'pasted_text_reference') {
    return { icon: 'i-lucide:clipboard-paste', color: 'var(--ema-warning)', label: '粘贴文本' };
  }
  const name = block.path.split(/[\\/]/).pop() ?? block.path;
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) {
    return { icon: 'i-mdi:image-outline', color: 'var(--ema-file-image)', label: name };
  }
  if (extension === 'pdf') return { icon: 'i-mdi:file-pdf-box', color: 'var(--ema-file-pdf)', label: name };
  if (['doc', 'docx'].includes(extension)) return { icon: 'i-mdi:file-word', color: 'var(--ema-file-word)', label: name };
  if (['ppt', 'pptx'].includes(extension)) return { icon: 'i-mdi:file-powerpoint', color: 'var(--ema-file-ppt)', label: name };
  if (['xls', 'xlsx'].includes(extension)) return { icon: 'i-mdi:file-excel', color: 'var(--ema-file-excel)', label: name };
  if (/^(ts|tsx|js|jsx|py|rs|go|cpp|c|java|rb|php|sh|yaml|yml|toml|sql)$/.test(extension)) {
    return { icon: 'i-mdi:file-code-outline', color: 'var(--ema-file-code)', label: name };
  }
  return { icon: 'i-lucide:paperclip', color: 'var(--ema-file-other)', label: name };
}
