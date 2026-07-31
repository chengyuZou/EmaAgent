// 立绘文件读侧校验:体积、真实格式、尺寸与数据库元数据一致性,与 normalizer 的写侧对称。
import fs from 'node:fs';
import sharp from 'sharp';
import { CHARACTER_RESOURCE_LIMITS } from '../resources/characterResourceLimits.js';
import type { CharacterPortraitMime } from './types.js';

export type PortraitCheckIssueCode =
  | 'resource_missing'
  | 'portrait_format_unsupported'
  | 'portrait_too_large'
  | 'portrait_dimensions_invalid'
  | 'portrait_metadata_mismatch';

export interface PortraitCheckIssue {
  readonly code: PortraitCheckIssueCode;
  readonly message: string;
}

/** 校验所需的立绘登记字段,与 CharacterPortrait 对应列一致。 */
export interface PortraitFileRecord {
  readonly relativePath: string;
  readonly mimeType: CharacterPortraitMime;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

const ALLOWED_PORTRAIT_FORMATS = new Set(['png', 'jpeg', 'webp']);

/**
 * 校验单张立绘,首个失败即返回;null 表示通过。
 * deep=false 只信数据库登记的尺寸;deep=true 用 sharp 读取真实格式、尺寸与字节并比对登记值。
 */
export async function inspectPortraitFile(
  portrait: PortraitFileRecord,
  absolutePath: string,
  deep: boolean,
): Promise<PortraitCheckIssue | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absolutePath);
  } catch {
    return {
      code: 'resource_missing',
      message: `角色资源文件在校验期间消失:${portrait.relativePath}`,
    };
  }
  if (stat.size > CHARACTER_RESOURCE_LIMITS.portraitInputBytes) {
    return {
      code: 'portrait_too_large',
      message: `角色立绘超过 ${CHARACTER_RESOURCE_LIMITS.portraitInputBytes} 字节限制。`,
    };
  }

  if (!deep) {
    if (!dimensionsAllowed(portrait.width, portrait.height)) {
      return {
        code: 'portrait_dimensions_invalid',
        message: '角色立绘登记的尺寸超过安全限制。',
      };
    }
    return null;
  }

  try {
    const metadata = await sharp(absolutePath, {
      animated: false,
      limitInputPixels: CHARACTER_RESOURCE_LIMITS.portraitPixels,
    }).metadata();
    if (!metadata.format || !ALLOWED_PORTRAIT_FORMATS.has(metadata.format)) {
      return {
        code: 'portrait_format_unsupported',
        message: '角色立绘实际格式只允许 PNG、JPEG 或 WebP。',
      };
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!dimensionsAllowed(width, height)) {
      return {
        code: 'portrait_dimensions_invalid',
        message: '角色立绘实际尺寸超过安全限制。',
      };
    }
    if (
      width !== portrait.width
      || height !== portrait.height
      || `image/${metadata.format}` !== portrait.mimeType
      || stat.size !== portrait.byteSize
    ) {
      return {
        code: 'portrait_metadata_mismatch',
        message: '角色立绘实际元数据与数据库记录不一致。',
      };
    }
    return null;
  } catch {
    return {
      code: 'portrait_format_unsupported',
      message: '角色立绘无法被安全解码。',
    };
  }
}

function dimensionsAllowed(width: number, height: number): boolean {
  return width > 0
    && height > 0
    && width <= CHARACTER_RESOURCE_LIMITS.portraitEdge
    && height <= CHARACTER_RESOURCE_LIMITS.portraitEdge
    && width * height <= CHARACTER_RESOURCE_LIMITS.portraitPixels;
}
