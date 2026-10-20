import { memo, useEffect, useState, type JSX } from 'react';
import { IconButton, Tooltip } from '@ema-agent/ui';
import type { ChatDraftReference } from '../../../stores/chatDraft.js';
import { tauriBridge } from '../../../lib/tauri/tauriBridge.js';
import { ImagePreview } from '../../../lib/images/imagePreview.js';
import { AttachmentImagePreview } from '../../../lib/images/attachmentImagePreview.js';
import { attachmentLabel } from '../../attachments/attachmentLabel.js';

interface DraftReferenceListProps {
  readonly sessionId: string | null;
  readonly references: readonly ChatDraftReference[];
  readonly onRemove: (draftId: string) => void;
}

function DraftImagePreview({ reference }: { readonly reference: Extract<ChatDraftReference, { type: 'image' }> }): JSX.Element {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setFailed(false);
    if (reference.file) {
      objectUrl = URL.createObjectURL(reference.file);
      setUrl(objectUrl);
    } else if (reference.sourcePath) {
      // 本机路径来自文件选择器. 预览只读入浏览器内存, 不提前上传或落盘到 Session.
      void tauriBridge.readLocalImage(reference.sourcePath).then((bytes) => {
        if (cancelled) return;
        const extension = reference.sourcePath?.split('.').pop()?.toLowerCase();
        const mimeType = extension === 'jpg' ? 'image/jpeg' : `image/${extension ?? 'png'}`;
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
        setUrl(objectUrl);
      }).catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reference.file, reference.sourcePath]);

  if (url) {
    return <ImagePreview src={url} alt={reference.name ?? '图片'} className="ema-image-preview--attachment" />;
  }
  return <span className="ema-attachment-image-placeholder" role="status">{failed ? '图片无法加载' : '加载图片中…'}</span>;
}

// 改 textarea 文字会重渲染 ChatInput, 但 references 数组没有变;
// 只在附件增删时重画列表, 不让每次打字都重建图片与删除按钮.
export const DraftReferenceList = memo(function DraftReferenceList({ sessionId, references, onRemove }: DraftReferenceListProps): JSX.Element | null {
  if (references.length === 0) return null;
  const attachments = references.filter(reference => reference.type !== 'skill_reference');
  const skills = references.filter(reference => reference.type === 'skill_reference');

  return (
    <div className="ema-draft-references">
      {attachments.length > 0 && (
        <>
          <div className="ema-draft-attachment-count">{attachments.length} 个附件</div>
          <div className="ema-draft-attachment-tray" role="group" aria-label="待发送附件">
            {attachments.map(reference => {
              const display = attachmentLabel(reference);
              const image = reference.type === 'image' || reference.type === 'image_reference';
              let preview: JSX.Element;
              if (reference.type === 'image') {
                preview = <DraftImagePreview reference={reference} />;
              } else if (reference.type === 'image_reference') {
                preview = (
                  <AttachmentImagePreview
                    sessionId={sessionId!}
                    path={reference.path}
                    alt={display.label}
                    className="ema-image-preview--attachment"
                  />
                );
              } else {
                preview = (
                  <div className="ema-draft-file-preview">
                    <span className={display.icon} style={{ color: display.color }} aria-hidden />
                    {(reference.type === 'pasted_text' || reference.type === 'pasted_text_reference') && (
                      <span className="ema-draft-text-excerpt">{reference.preview}</span>
                    )}
                  </div>
                );
              }
              return (
                <div key={reference.draftId} className="ema-draft-attachment-card" data-image={image}>
                  <div className="ema-draft-attachment-preview">{preview}</div>
                  <Tooltip content={display.detail} variant="card">
                    <div className="ema-draft-attachment-name" tabIndex={0}>
                      <span className={display.icon} style={{ color: display.color }} aria-hidden />
                      <span>{display.label}</span>
                    </div>
                  </Tooltip>
                  <IconButton
                    size="sm"
                    variant="ghost"
                    icon="i-lucide:x"
                    className="ema-draft-attachment-remove"
                    label={`移除附件: ${display.label}`}
                    onClick={() => onRemove(reference.draftId)}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
      {skills.length > 0 && (
        <div className="ema-draft-skill-tray" role="group" aria-label="已选择的技能">
          {skills.map(reference => (
            <span key={reference.draftId} className="ema-attachment-chip ema-draft-skill">
              <span className="i-lucide:sparkles" aria-hidden />
              <Tooltip content={reference.path} variant="card">
                <span className="ema-attachment-chip-label">{reference.name}</span>
              </Tooltip>
              <IconButton
                size="sm"
                variant="ghost"
                icon="i-lucide:x"
                className="ema-draft-skill-remove"
                label={`移除技能: ${reference.name}`}
                onClick={() => onRemove(reference.draftId)}
              />
            </span>
          ))}
        </div>
      )}
    </div>
  );
});
