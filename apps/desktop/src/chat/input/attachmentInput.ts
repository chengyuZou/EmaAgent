// 附件元数据转换:Rust 已签发 fileHandle,前端只补 UI id 与 MIME 展示信息。
import type { AuthorizedFile } from '../../lib/tauri-bridge.js';
import type { AttachmentInputWire } from '../../api/turns.js';

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

export function authorizedFileToAttachment(file: AuthorizedFile): AttachmentInputWire {
  return {
    id:        crypto.randomUUID(),
    name:      file.name,
    mimeType:  mimeFromName(file.name),
    size:      file.size,
    mtime:     file.mtime,
    fileHandle: file.fileHandle,
  };
}
