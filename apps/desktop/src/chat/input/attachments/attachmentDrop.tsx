import type { JSX } from 'react';
import { tauriBridge } from '../../../lib/tauri/tauriBridge.js';
import { showToast } from '../../../lib/notifications/toast.js';
import { appendAttachmentPaths } from './draftAttachments.js';
import { editChatDraft } from '../editChatDraft.js';
import { useFileDrop } from '../../../lib/fileDrop.js';

export function useAttachmentDrop(sessionId: string | null) {
  async function addPaths(paths: readonly string[]): Promise<void> {
    const result = await tauriBridge.inspectAttachmentPaths(paths);
    if (result.rejected.length > 0) {
      showToast('文件夹或无法读取的文件未添加', { variant: 'warning' });
    }
    if (result.files.length > 0) {
      editChatDraft(sessionId, current => appendAttachmentPaths(current, result.files));
    }
  }

  return useFileDrop('chat', addPaths);
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
