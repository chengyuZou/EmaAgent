// 按源文件名保存立绘原图，只检查文件大小与常见图片文件头，不改写图片内容。

import fs from 'node:fs';
import { CharacterResourceValidationError } from '../errors.js';
import { sourceBaseName, sourceFileName } from '../resources/resourcePaths.js';
import {
  copyResourceFile,
  exportResourceFile,
  removeFileIfPresent,
} from '../resources/resourceFiles.js';

export interface ImportedIllustrationFile {
  readonly name: string;
  readonly displayName: string;
  readonly byteSize: number;
}

export async function importIllustrationFile(
  sourceFile: string,
  destination: string,
): Promise<ImportedIllustrationFile> {
  const fileName = sourceFileName(sourceFile);
  await assertImageFile(sourceFile);
  const byteSize = await copyResourceFile(sourceFile, destination);
  return { name: fileName, displayName: sourceBaseName(sourceFile), byteSize };
}

export { exportResourceFile as exportIllustrationFile };
export { removeFileIfPresent as deleteIllustrationFile };

export function inspectIllustrationFileSync(filePath: string): 'valid' | 'missing' | 'invalid' {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, 'r');
  } catch {
    return 'missing';
  }
  try {
    const head = Buffer.alloc(16);
    const bytesRead = fs.readSync(descriptor, head, 0, head.length, 0);
    const value = head.subarray(0, bytesRead);
    return isPng(value) || isJpeg(value) || isGif(value) || isWebp(value) ? 'valid' : 'invalid';
  } finally {
    fs.closeSync(descriptor);
  }
}

async function assertImageFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r').catch(() => null);
  if (!handle) throw new CharacterResourceValidationError('source_file_required');
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const value = head.subarray(0, bytesRead);
    if (!isPng(value) && !isJpeg(value) && !isGif(value) && !isWebp(value)) {
      throw new CharacterResourceValidationError('illustration_format_unsupported');
    }
  } finally {
    await handle.close();
  }
}

function isPng(value: Buffer): boolean {
  return value.length >= 8 && value.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
}

function isJpeg(value: Buffer): boolean {
  return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
}

function isGif(value: Buffer): boolean {
  const magic = value.subarray(0, 6).toString('ascii');
  return magic === 'GIF87a' || magic === 'GIF89a';
}

function isWebp(value: Buffer): boolean {
  return value.length >= 12
    && value.subarray(0, 4).toString('ascii') === 'RIFF'
    && value.subarray(8, 12).toString('ascii') === 'WEBP';
}
