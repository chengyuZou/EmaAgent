// 解码并重写立绘以移除 EXIF 等隐式元数据，同时冻结真实格式和尺寸。

import fs from 'node:fs';
import sharp from 'sharp';
import { CharacterResourceValidationError } from '../errors.js';
import { CHARACTER_RESOURCE_LIMITS } from '../resources/characterResourceLimits.js';
import type { CharacterPortraitMime } from './types.js';

export interface NormalizedPortrait {
  readonly mimeType: CharacterPortraitMime;
  readonly extension: 'png' | 'jpg' | 'webp';
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

export async function normalizePortrait(
  sourcePath: string,
  destinationPath: string,
): Promise<NormalizedPortrait> {
  const sourceStat = await fs.promises.lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new CharacterResourceValidationError('source_file_required');
  }
  if (sourceStat.size > CHARACTER_RESOURCE_LIMITS.portraitInputBytes) {
    throw new CharacterResourceValidationError('resource_too_large');
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(sourcePath, {
      animated: false,
      limitInputPixels: CHARACTER_RESOURCE_LIMITS.portraitPixels,
    }).metadata();
  } catch {
    throw new CharacterResourceValidationError('portrait_format_unsupported');
  }
  const format = normalizeFormat(metadata.format);
  const swapsAxes = metadata.orientation !== undefined
    && metadata.orientation >= 5
    && metadata.orientation <= 8;
  const width = (swapsAxes ? metadata.height : metadata.width) ?? 0;
  const height = (swapsAxes ? metadata.width : metadata.height) ?? 0;
  if (!dimensionsAllowed(width, height)) {
    throw new CharacterResourceValidationError('portrait_dimensions_invalid');
  }

  try {
    const pipeline = sharp(sourcePath, {
      animated: false,
      limitInputPixels: CHARACTER_RESOURCE_LIMITS.portraitPixels,
    }).rotate();
    if (format === 'png') await pipeline.png().toFile(destinationPath);
    else if (format === 'jpeg') await pipeline.jpeg({ quality: 92 }).toFile(destinationPath);
    else await pipeline.webp({ quality: 92 }).toFile(destinationPath);

    const output = await fs.promises.stat(destinationPath);
    if (output.size > CHARACTER_RESOURCE_LIMITS.portraitOutputBytes) {
      throw new CharacterResourceValidationError('resource_too_large');
    }
    return {
      mimeType: format === 'jpeg' ? 'image/jpeg' : `image/${format}`,
      extension: format === 'jpeg' ? 'jpg' : format,
      byteSize: output.size,
      width,
      height,
    };
  } catch (error) {
    await fs.promises.rm(destinationPath, { force: true }).catch(() => undefined);
    if (error instanceof CharacterResourceValidationError) throw error;
    throw new CharacterResourceValidationError('portrait_format_unsupported');
  }
}

function normalizeFormat(value: string | undefined): 'png' | 'jpeg' | 'webp' {
  if (value === 'png' || value === 'jpeg' || value === 'webp') return value;
  throw new CharacterResourceValidationError('portrait_format_unsupported');
}

function dimensionsAllowed(width: number, height: number): boolean {
  return width > 0
    && height > 0
    && width <= CHARACTER_RESOURCE_LIMITS.portraitEdge
    && height <= CHARACTER_RESOURCE_LIMITS.portraitEdge
    && width * height <= CHARACTER_RESOURCE_LIMITS.portraitPixels;
}
