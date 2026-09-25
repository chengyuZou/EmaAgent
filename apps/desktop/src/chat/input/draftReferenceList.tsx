// 展示草稿中按加入顺序排列的图片、文件、长粘贴与 Skill; 不修改 textarea 文字.
import { memo, useEffect, useState, type JSX } from 'react';
import type { ChatDraftReference } from '../../stores/chatDraft.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';

interface DraftReferenceListProps {
  readonly references: readonly ChatDraftReference[];
  readonly onRemove: (draftId: string) => void;
}

function referenceLabel(reference: ChatDraftReference): string {
  if (reference.type === 'skill_reference') return reference.name;
  if (reference.type === 'file_reference') return reference.path.split(/[\\/]/).pop() ?? '';
  if (reference.type === 'pasted_text') return `粘贴文本: ${reference.preview}`;
  return reference.name ?? '图片';
}

function ImagePreview({ reference }: { readonly reference: Extract<ChatDraftReference, { type: 'image' }> }): JSX.Element {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    if (reference.file) {
      objectUrl = URL.createObjectURL(reference.file);
      setUrl(objectUrl);
    } else if (reference.sourcePath) {
      // 本机路径来自文件选择器. 预览只读入浏览器内存, 不提前上传或落盘到 Session.
      void tauriBridge.readDraftImage(reference.sourcePath).then((bytes) => {
        if (cancelled) return;
        const extension = reference.sourcePath?.split('.').pop()?.toLowerCase();
        const mimeType = extension === 'jpg' ? 'image/jpeg' : `image/${extension ?? 'png'}`;
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
        setUrl(objectUrl);
      }).catch(() => { if (!cancelled) setUrl(undefined); });
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reference.file, reference.sourcePath]);

  return url
    ? <img src={url} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
    : <span className="i-lucide:image shrink-0 text-base" aria-hidden />;
}

// 改 textarea 文字会重渲染 ChatInput, 但 references 数组没有变;
// 只在胶囊增删时重画列表, 不让每次打字都重建图片与删除按钮.
export const DraftReferenceList = memo(function DraftReferenceList({ references, onRemove }: DraftReferenceListProps): JSX.Element | null {
  if (references.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pb-2 pt-3">
      {references.map(reference => (
        <span
          key={reference.draftId}
          className="inline-flex max-w-52 items-center gap-1.5 rounded-md border border-[var(--ema-border)] bg-[var(--ema-primary-muted)] px-2 py-1 text-[11px] text-[var(--ema-primary-text)]"
        >
          {reference.type === 'image'
            ? <ImagePreview reference={reference} />
            : <span className={reference.type === 'skill_reference' ? 'i-lucide:box' : 'i-lucide:paperclip'} aria-hidden />}
          <span className="truncate" title={reference.type === 'pasted_text' ? reference.preview : undefined}>
            {referenceLabel(reference)}
          </span>
          <button
            type="button"
            className="i-lucide:x shrink-0 opacity-60 hover:opacity-100"
            aria-label={`移除这个附件或技能`}
            onClick={() => onRemove(reference.draftId)}
          />
        </span>
      ))}
    </div>
  );
});
