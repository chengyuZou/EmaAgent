import {
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { tauriBridge } from '../../lib/tauri/tauriBridge.js';
import { showToast } from '../../lib/notifications/toast.js';
import { appendAttachmentPaths } from './draftAttachments.js';
import { editChatDraft } from './editChatDraft.js';

export function useAttachmentDrop(sessionId: string | null) {
  const dropAreaRef = useRef<HTMLElement | null>(null);
  const [overlayWidth, setOverlayWidth] = useState<number | null>(null);

  function widthAtPoint(x: number, y: number): number | null {
    const element = dropAreaRef.current;
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    const column = element.querySelector<HTMLElement>('[data-ema-chat-column]');
    // 标题栏横跨两列, 但接收范围只延伸到聊天列的右边, 不包含工作区.
    const right = column?.getBoundingClientRect().right ?? bounds.right;
    if (x < bounds.left || x >= right || y < bounds.top || y >= bounds.bottom) {
      return null;
    }
    return right - bounds.left;
  }

  async function addPaths(paths: readonly string[]): Promise<void> {
    const result = await tauriBridge.inspectAttachmentPaths(paths);
    if (result.rejected.length > 0) {
      showToast('文件夹或无法读取的文件未添加', { variant: 'warning' });
    }
    if (result.files.length > 0) {
      editChatDraft(sessionId, current => appendAttachmentPaths(current, result.files));
    }
  }

  function reportError(error: unknown): void {
    showToast(error instanceof Error ? error.message : '添加拖入附件失败', { variant: 'danger' });
  }

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    setOverlayWidth(null);
    void tauriBridge.listenAttachmentDrag(event => {
      if (disposed) return;
      if (event.type === 'leave') {
        setOverlayWidth(null);
        return;
      }
      const width = widthAtPoint(event.x, event.y);
      if (event.type === 'drop') {
        setOverlayWidth(null);
        if (width !== null) void addPaths(event.paths).catch(reportError);
      } else {
        setOverlayWidth(width);
      }
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(reportError);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId]);

  return { dropAreaRef, overlayWidth };
}

export function AttachmentDropOverlay({ width }: { readonly width: number | null }): JSX.Element | null {
  if (width === null) return null;

  return (
    <div
      className="ema-attachment-drop-overlay"
      style={{ width }}
      aria-hidden="true"
    >
      <div className="ema-attachment-drop-label">
        <span className="i-lucide:paperclip" aria-hidden="true" />
        <span>松开即可添加附件</span>
      </div>
    </div>
  );
}
