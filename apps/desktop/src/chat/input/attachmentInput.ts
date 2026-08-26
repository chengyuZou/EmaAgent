// 附件元数据转换:原生选框返回的绝对路径补 UI id 与 MIME 展示信息;
// size/mtime 留空由 Server realpath/stat 权威化(attachments README:传输层字段仅展示)。
import type { TurnAttachmentInput } from '../../api/turns.js';

/** 输入框待发送附件:传输层载荷 + 仅前端使用的列表 id。 */
export interface PendingAttachment extends TurnAttachmentInput {
  readonly id: string;
}

function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] ?? 'application/octet-stream';
}

export function filePathToAttachment(path: string): PendingAttachment {
  const name = path.replaceAll('\\', '/').split('/').pop() ?? path;
  return {
    id:        crypto.randomUUID(),
    path,
    name,
    mimeType:  mimeFromName(name),
  };
}
