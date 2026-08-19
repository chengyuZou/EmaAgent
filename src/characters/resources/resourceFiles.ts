// 提供三类角色资源共享的排他复制、缺失容忍删除和按显示名导出文件操作。

import fs from 'node:fs';
import path from 'node:path';
import { CharacterResourceValidationError } from '../errors.js';
import { displayFileName } from './resourcePaths.js';

export async function copyResourceFile(
  source: string,
  destination: string,
  maxBytes: number,
): Promise<number> {
  const stat = await fs.promises.stat(source).catch(() => null);
  if (!stat?.isFile()) throw new CharacterResourceValidationError('source_file_required');
  if (stat.size <= 0 || stat.size > maxBytes) {
    throw new CharacterResourceValidationError('resource_too_large');
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new CharacterResourceValidationError('resource_name_conflict');
    }
    throw error;
  }
  return stat.size;
}

export async function writeResourceFile(
  destination: string,
  bytes: Uint8Array,
  maxBytes: number,
): Promise<void> {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new CharacterResourceValidationError('resource_too_large');
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.writeFile(destination, bytes, { flag: 'wx' });
}

export async function exportResourceFile(
  source: string,
  destinationDirectory: string,
  displayName: string,
): Promise<string> {
  const destination = await fs.promises.stat(destinationDirectory).catch(() => null);
  if (!destination?.isDirectory()) {
    throw new CharacterResourceValidationError('destination_directory_required');
  }
  const target = path.join(
    destinationDirectory,
    displayFileName(displayName, path.extname(source)),
  );
  try {
    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    return target;
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new CharacterResourceValidationError('export_destination_exists');
    }
    throw error;
  }
}

export async function removeFileIfPresent(filePath: string): Promise<void> {
  await fs.promises.rm(filePath, { force: true });
}

export async function removeDirectoryIfPresent(directory: string): Promise<void> {
  await fs.promises.rm(directory, { recursive: true, force: true });
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
