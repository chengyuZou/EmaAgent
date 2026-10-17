export interface StoreSweepReport {
  /** 已清理的数据库记录及无记录文件数量. 记录对应的文件删除失败也计入, 不是磁盘删除成功数. */
  readonly deletedFiles: number;
  /** 按数据库记录的大小和已删除文件大小累计的字节数, 不是实际磁盘空闲量的测量值. */
  readonly freedBytes: number;
}

// 当前图片上传与模型输入按这四种格式分类, 其他格式作为普通文件引用.
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

/** 只根据扩展名预分类, 实际图片字节由 ImageStore 解码检查. */
export function isLLMImagePath(filePath: string): boolean {
  return LLM_IMAGE_MIMES.has(mimeForPath(filePath));
}
