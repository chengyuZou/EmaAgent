import { useCallback, type ClipboardEvent as ReactClipboardEvent } from 'react';
import { PASTE_TEXT_MIN_CHARS } from '@ema-agent/attachments/limits';
import type { ChatDraft, ChatDraftReference } from '../../../stores/chatDraft.js';
import { tauriBridge } from '../../../lib/tauri/tauriBridge.js';
import { showToast } from '../../../lib/notifications/toast.js';

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
