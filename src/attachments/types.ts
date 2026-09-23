/**
 * 存储清扫报告
 * @property deletedFiles 删除的文件数
 * @property freedBytes 释放的字节数
 */
export interface StoreSweepReport {
  readonly deletedFiles: number;
  readonly freedBytes: number;
}

/**
 * LLM 图片输入只担保这四类;bmp/avif/svg 等其余图片格式按普通 file 处理.
 */
const LLM_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const EXTENSION_MIME: Record<string, string> = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
  '.avif': 'image/avif',
  '.svg':  'image/svg+xml',
  '.pdf':  'application/pdf',
  '.md':   'text/markdown',
  '.txt':  'text/plain',
  '.log':  'text/plain',
  '.csv':  'text/csv',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip':  'application/zip',
};

export function mimeForPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return EXTENSION_MIME[filePath.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

export function isLlmImagePath(filePath: string): boolean {
  return LLM_IMAGE_MIMES.has(mimeForPath(filePath));
}
