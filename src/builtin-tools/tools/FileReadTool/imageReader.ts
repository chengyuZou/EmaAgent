import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_FILE_SIZE_LIMIT } from './limits.js';

/** 图片扩展名 → MIME 单点映射; 命中即走图片分支, 不再落到文本二进制拒绝. */
const IMAGE_MEDIA_TYPES = new Map<string, ImageMediaType>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** 图片正文为 base64, originalBytes 是原文件字节数. */
export interface FileReadImageResult {
  type: 'image_content';
  filePath: string;
  mediaType: ImageMediaType;
  base64: string;
  originalBytes: number;
}

export function imageMediaTypeFor(filePath: string): ImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES.get(path.extname(filePath).toLowerCase());
}

/**
 * 图片不写入 FileStateCache, 避免将 base64 当成 Edit 的原文件内容.
 * 每次读取重新编码, 不缩放或转换格式.
 */
export async function readImageFile(options: {
  fullPath: string;
  displayPath: string;
  mediaType: ImageMediaType;
  sizeBytes: number;
  signal: AbortSignal;
}): Promise<FileReadImageResult> {
  const { fullPath, displayPath, mediaType, sizeBytes, signal } = options;
  if (sizeBytes > IMAGE_FILE_SIZE_LIMIT) {
    throw new Error(
      `Image is too large (${(sizeBytes / 1024 / 1024).toFixed(1)} MiB > 5 MiB). `
        + `Downscale it first, or read a smaller version.`,
    );
  }
  const buffer = await fs.promises.readFile(fullPath, { signal });
  return {
    type: 'image_content',
    filePath: displayPath,
    mediaType,
    base64: buffer.toString('base64'),
    originalBytes: sizeBytes,
  };
}
