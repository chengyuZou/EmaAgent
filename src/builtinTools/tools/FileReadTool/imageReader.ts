// FileReadTool 的图片读取分支: 媒体类型判定、体积门与 base64 加载。
// V1 不缩放不改格式(无图像处理依赖); 超限直接拒绝, 不静默降级。
import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_FILE_SIZE_LIMIT } from './limits.js';

/** 图片扩展名 → MIME 单点映射; 命中即走图片分支, 不再落到文本二进制拒绝。 */
const IMAGE_MEDIA_TYPES = new Map<string, ImageMediaType>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** 图片正文(base64); 与文本/去重结果在 FileReadTool 组成判别联合。 */
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
 * 读取图片并编码 base64。图片不进 readFileState: Edit 只比对文本原文,
 * 缓存 base64 纯属内存浪费; 重复读图每次重新编码, V1 接受这个代价。
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
