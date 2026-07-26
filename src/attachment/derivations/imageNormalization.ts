// 统一图片方向、尺寸和编码并移除 EXIF/GPS，给直接模型输入与 Vision 缓存共用。
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import type {
  AttachmentImageSource,
  NormalizedAttachmentImage,
} from '../types.js';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_LONG_EDGE = 2_048;

export const ATTACHMENT_IMAGE_TRANSFORM_VERSION = 'attachment-image-v1';

export async function normalizeAttachmentImage(
  source: AttachmentImageSource,
  signal?: AbortSignal,
): Promise<NormalizedAttachmentImage> {
  signal?.throwIfAborted();
  const input = await readSource(source);
  if (input.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(
      `图片超过单文件上限 ${(MAX_SOURCE_BYTES / 1024 / 1024).toFixed(0)} MiB`,
    );
  }

  const pipeline = sharp(input, {
    animated: false,
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
  });
  const metadata = await pipeline.metadata();
  signal?.throwIfAborted();

  if (!metadata.width || !metadata.height) {
    throw new Error('无法识别图片尺寸');
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new Error('V1 暂不把动画图片静默压成单帧，请上传静态 PNG、JPEG 或 WebP');
  }

  // rotate() 应用 EXIF orientation；未调用 withMetadata() 时 Sharp 会移除
  // GPS、设备型号、拍摄时间等元数据，避免它们随图片发送到远端。
  const transformed = pipeline
    .rotate()
    .resize({
      width: MAX_LONG_EDGE,
      height: MAX_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 85, alphaQuality: 90, effort: 4 });
  const { data, info } = await transformed.toBuffer({ resolveWithObject: true });
  signal?.throwIfAborted();

  return {
    bytes: new Uint8Array(data),
    mimeType: 'image/webp',
    width: info.width,
    height: info.height,
    contentSha256: createHash('sha256').update(data).digest('hex'),
    transformVersion: ATTACHMENT_IMAGE_TRANSFORM_VERSION,
  };
}

async function readSource(source: AttachmentImageSource): Promise<Uint8Array> {
  switch (source.kind) {
    case 'path': {
      const sourceStat = await stat(source.path);
      if (!sourceStat.isFile()) throw new Error('图片来源不是普通文件');
      if (sourceStat.size > MAX_SOURCE_BYTES) {
        throw new Error(
          `图片超过单文件上限 ${(MAX_SOURCE_BYTES / 1024 / 1024).toFixed(0)} MiB`,
        );
      }
      return new Uint8Array(await readFile(source.path));
    }
    case 'bytes':
      return source.bytes;
    case 'base64':
      // Base64 长度约为原始字节的 4/3；先拒绝明显超限内容，避免先分配大 Buffer。
      if (source.data.length > Math.ceil(MAX_SOURCE_BYTES * 4 / 3) + 4) {
        throw new Error(
          `图片超过单文件上限 ${(MAX_SOURCE_BYTES / 1024 / 1024).toFixed(0)} MiB`,
        );
      }
      return new Uint8Array(Buffer.from(source.data, 'base64'));
  }
}
