import { memo, useCallback, useEffect, useState, type ClipboardEvent as ReactClipboardEvent, type JSX } from 'react';
import { PASTE_TEXT_MIN_CHARS } from '@ema-agent/attachments/limits';
import type { ChatDraft, ChatDraftReference } from '../../stores/chatDraft.js';
import { tauriBridge } from '../../lib/tauri/tauriBridge.js';
import { ImagePreview } from '../../lib/images/imagePreview.js';
import { AttachmentImagePreview } from '../../lib/images/attachmentImagePreview.js';
import { Tooltip } from '@ema-agent/ui';
import { showToast } from '../../lib/notifications/toast.js';

interface AttachmentSelection {
  readonly sessionId: string | null;
  valid: boolean;
}

// 选择框可以跨页面存活. 提交原草稿时使其失效, 切换页面本身不取消选择.
const attachmentSelections = new Set<AttachmentSelection>();

export function invalidateAttachmentSelections(sessionId: string | null): void {
  for (const selection of attachmentSelections) {
    if (selection.sessionId === sessionId) selection.valid = false;
  }
}

interface DraftReferenceListProps {
  readonly sessionId: string | null;
  readonly references: readonly ChatDraftReference[];
  readonly onRemove: (draftId: string) => void;
}

function referenceLabel(reference: ChatDraftReference): string {
  if (reference.type === 'skill_reference') return reference.name;
  if (reference.type === 'file_reference') return reference.path.split(/[\\/]/).pop() ?? '';
  if (reference.type === 'pasted_text' || reference.type === 'pasted_text_reference') {
    return `粘贴文本: ${reference.preview}`;
  }
  return reference.name ?? '图片';
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
  return (
    <div className="flex flex-wrap items-start gap-1.5 px-3 pb-2 pt-3">
      {references.map(reference => {
        if (reference.type === 'image' || reference.type === 'image_reference') {
          return (
            <span key={reference.draftId} className="ema-draft-image-reference">
              {reference.type === 'image' ? (
                <DraftImagePreview reference={reference} />
              ) : (
                <AttachmentImagePreview
                  sessionId={sessionId!} path={reference.path}
                  alt={reference.name ?? '图片'} className="ema-image-preview--attachment"
                />
              )}
              <span className="ema-draft-image-name" title={referenceLabel(reference)}>{referenceLabel(reference)}</span>
              <button
                type="button"
                className="ema-draft-image-remove"
                aria-label="移除这个图片附件"
                onClick={() => onRemove(reference.draftId)}
              >
                <span className="i-lucide:x" aria-hidden />
              </button>
            </span>
          );
        }
        return (
          <span
            key={reference.draftId}
            className="inline-flex max-w-52 items-center gap-1.5 rounded-md border border-[var(--ema-border)] bg-[var(--ema-primary-muted)] px-2 py-1 text-[11px] text-[var(--ema-primary-text)]"
          >
            <span className={reference.type === 'skill_reference' ? 'i-lucide:box' : 'i-lucide:paperclip'} aria-hidden />
            <Tooltip
              content={reference.type === 'pasted_text' || reference.type === 'pasted_text_reference' ? reference.preview : undefined}
              variant="card"
            >
              <span className="truncate">
                {referenceLabel(reference)}
              </span>
            </Tooltip>
            <button
              type="button"
              className="i-lucide:x shrink-0 opacity-60 hover:opacity-100"
              aria-label="移除这个附件或技能"
              onClick={() => onRemove(reference.draftId)}
            />
          </span>
        );
      })}
    </div>
  );
});

function isLLMImagePath(filePath: string): boolean {
  return ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(filePath.split('.').pop()?.toLowerCase() ?? '');
}

export function appendAttachmentPaths(
  draft: ChatDraft,
  paths: readonly string[],
): ChatDraft {
  const references = paths.map((sourcePath): ChatDraftReference => {
    if (isLLMImagePath(sourcePath)) {
      return {
        draftId: crypto.randomUUID(),
        type: 'image',
        sourcePath,
        name: sourcePath.split(/[\\/]/).pop(),
      };
    }
    return {
      draftId: crypto.randomUUID(),
      type: 'file_reference',
      path: sourcePath,
    };
  });
  return {
    ...draft,
    references: [...draft.references, ...references],
  };
}

export function useDraftAttachments(
  sessionId: string | null,
  editCurrentDraft: (edit: (current: ChatDraft) => ChatDraft) => void,
) {
  function appendReferences(items: readonly ChatDraftReference[]): void {
    editCurrentDraft(current => ({
      ...current,
      references: [...current.references, ...items],
    }));
  }

  const removeReference = useCallback((draftId: string): void => {
    editCurrentDraft(current => ({
      ...current,
      references: current.references.filter(reference => reference.draftId !== draftId),
    }));
  }, [editCurrentDraft]);

  async function pickAttachments(): Promise<void> {
    const selection: AttachmentSelection = { sessionId, valid: true };
    attachmentSelections.add(selection);
    try {
      const paths = await tauriBridge.selectPaths({ multiple: true, title: '添加附件' });
      if (selection.valid && paths.length > 0) {
        editCurrentDraft(current => appendAttachmentPaths(current, paths));
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: 'danger' });
    } finally {
      attachmentSelections.delete(selection);
    }
  }

  function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    const image = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith('image/'));
    if (image) {
      event.preventDefault();
      appendReferences([{ draftId: crypto.randomUUID(), type: 'image', file: image, name: image.name || undefined }]);
      return;
    }
    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    if (pasted.length >= PASTE_TEXT_MIN_CHARS) {
      event.preventDefault();
      appendReferences([{
        draftId: crypto.randomUUID(),
        type: 'pasted_text',
        content: pasted,
        preview: `${pasted.slice(0, 120)}${pasted.length > 120 ? '…' : ''}`,
      }]);
    }
  }

  return { pickAttachments, handlePaste, removeReference };
}
