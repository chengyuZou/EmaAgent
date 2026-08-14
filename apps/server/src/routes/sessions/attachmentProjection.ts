// 把后端附件记录投影成前端可用的能力句柄，不向 WebView 泄露绝对路径。
import type { AttachmentStorePort, FileAccessFacade } from '@ema-agent/attachment';
import type { TurnAttachment } from '@ema-agent/turn';

export interface AttachmentProjection {
  attachmentStore: Pick<AttachmentStorePort, 'listByTurn'>;
  fileAccess: Pick<FileAccessFacade, 'issue'>;
}

export function issueStoredFileHandle(
  fileAccess: Pick<FileAccessFacade, 'issue'>,
  localPath: string,
): string | null {
  try {
    return fileAccess.issue(localPath);
  } catch (error) {
    console.warn('[attachments] 无法为历史路径签发文件能力:', error);
    return null;
  }
}

export function enrichStoredAttachments<T extends {
  role: string;
  turnId: string | null;
}>(
  projection: AttachmentProjection,
  messages: readonly T[],
): Array<T & { attachments?: TurnAttachment[] }> {
  return messages.map((message) => {
    if (message.role !== 'user' || !message.turnId) return message;
    const rows = projection.attachmentStore.listByTurn(message.turnId);
    if (rows.length === 0) return message;

    const attachments: TurnAttachment[] = rows.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mime,
      size: attachment.size,
      mtime: attachment.mtime,
      fileHandle: issueStoredFileHandle(projection.fileAccess, attachment.localPath),
    }));
    return { ...message, attachments };
  });
}
