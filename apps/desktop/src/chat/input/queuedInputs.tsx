import type { JSX } from 'react';
import { Button, IconButton, Tooltip } from '@ema-agent/ui';
import type { TurnInputPart } from '@ema-agent/turn';
import { runWithToast } from '../../lib/notifications/toast.js';
import { sessionWebSocket } from '../../api/sessionWebSocket.js';
import { useSessionActivityStore } from '../../stores/sessionActivity.js';
import { AttachmentImagePreview } from '../../lib/images/attachmentImagePreview.js';
import { AttachmentGroup } from '../attachments/attachmentGroup.js';
import { attachmentLabel } from '../attachments/attachmentLabel.js';

function QueuedInputContent({ sessionId, input }: {
  readonly sessionId: string;
  readonly input: readonly TurnInputPart[];
}): JSX.Element {
  const text = input
    .filter((part): part is Extract<TurnInputPart, { type: 'text' }> => (
      part.type === 'text'
    ))
    .map((part) => part.text)
    .join('')
    .trim();
  const attachments = input
    .filter(part => part.type !== 'text')
    .map(part => part.type === 'attachment' ? part.block : part);
  const images = attachments.filter(part => part.type === 'image_reference');
  const references = attachments.filter(part => part.type !== 'image_reference');
  return (
    <div className="ema-queued-input-content">
      {text && <div className="truncate text-[var(--ema-text-secondary)]" title={text}>{text}</div>}
      {images.length > 0 && (
        <AttachmentGroup label="图片">
          {images.map((image, index) => (
            <AttachmentImagePreview
              key={`${image.path}-${index}`}
              sessionId={sessionId}
              path={image.path}
              alt={image.name ?? '排队图片'}
              className="ema-image-preview--attachment"
            />
          ))}
        </AttachmentGroup>
      )}
      {references.length > 0 && (
        <AttachmentGroup label="附件">
          {references.map((reference, index) => {
            const display = attachmentLabel(reference);
            return (
              <Tooltip key={`${reference.type}-${reference.path}-${index}`} content={display.detail} variant="card">
                <span tabIndex={0} className="ema-attachment-chip">
                  <span className={display.icon} style={{ color: display.color }} aria-hidden />
                  <span className="ema-attachment-chip-label">{display.label}</span>
                </span>
              </Tooltip>
            );
          })}
        </AttachmentGroup>
      )}
    </div>
  );
}

export function QueuedInputs({ sessionId }: { readonly sessionId: string | null }): JSX.Element {
  const activity = useSessionActivityStore(state => sessionId ? state.bySession.get(sessionId) : undefined);
  const turnRunning = activity?.running?.kind === 'turn';
  const queuedInputs = activity?.queuedInputs.filter(item => item.delivery === 'after_turn') ?? [];

  // 容器常驻挂载, 移除排队项后仍可播放收拢动画.
  return (
    <div
      className="ema-collapsible"
      style={{
        gridTemplateRows: queuedInputs.length > 0 ? '1fr' : '0fr',
        opacity: queuedInputs.length > 0 ? 1 : 0,
      }}
    >
      <div>
        <div className="ema-queued-input-list mb-2 flex flex-col gap-1.5">
          {queuedInputs.map(item => (
            <div
              key={item.id}
              className="ema-fade-in flex shrink-0 items-center gap-2 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] px-3 py-2 text-xs"
            >
              <span className="i-lucide:clock-3 text-[var(--ema-text-tertiary)]" aria-hidden />
              <QueuedInputContent sessionId={sessionId!} input={item.input} />
              {turnRunning && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 text-[var(--ema-primary)]"
                  onClick={() => void runWithToast(sessionWebSocket.guideQueuedInput(sessionId!, item.id), '立即引导失败')}
                >
                  立即引导
                </Button>
              )}
              <IconButton
                size="sm"
                variant="ghost"
                icon="i-lucide:x"
                label="删除排队输入"
                onClick={() => void runWithToast(sessionWebSocket.removeQueuedInput(sessionId!, item.id), '删除排队消息失败')}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
