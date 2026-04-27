/**
 * 文件检测相关的常量与工具函数。
 */

/** 常见二进制文件扩展名白名单（判定逻辑：不在此名单的文本扩展名视为文本） */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // 图像（svg 为纯文本 XML，单独处理）
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico",
  // 音频
  "mp3", "wav", "ogg", "flac", "aac", "m4a",
  // 视频
  "mp4", "avi", "mkv", "mov", "wmv", "flv",
  // 压缩/归档
  "zip", "rar", "7z", "tar", "gz", "bz2",
  // 可执行/库
  "exe", "dll", "so", "dylib", "bin",
  // Office 二进制
  "doc", "xls", "ppt",
  // 其他
  "pdf", "epub", "psd", "ai", "sketch",
]);

/**
 * 根据文件路径扩展名判断是否可能为二进制文件。
 *
 * @remarks
 * 后缀判断是快速路径，存在误判（如 `.ts` 视频文件 vs TypeScript），
 * 对不确定的文件应进一步调用 {@link isBinaryContent}。
 */
export function hasBinaryExtension(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * 读取文件前若干字节，通过是否存在 NUL 字节判定是否为二进制。
 *
 * @param buf - 文件内容 Buffer（建议只读前 8KB）
 */
export function isBinaryContent(buf: Buffer): boolean {
  const sampleSize = Math.min(buf.length, 8192);
  for (let i = 0; i < sampleSize; i++) {
    if (buf[i] === 0x00) return true;
  }
  return false;
}
