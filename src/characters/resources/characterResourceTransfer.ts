// 直接复制角色资源到最终目录或用户选择的导出目录，不维护中间事务目录。

import fs from 'node:fs';
import path from 'node:path';
import { CharacterResourceValidationError } from '../errors.js';

export async function copyCharacterFile(
  source: string,
  destination: string,
  maxBytes?: number,
): Promise<number> {
  const stat = await fs.promises.stat(source).catch(() => null);
  if (!stat?.isFile()) {
    throw new CharacterResourceValidationError('source_file_required');
  }
  if (maxBytes !== undefined && stat.size > maxBytes) {
    throw new CharacterResourceValidationError('resource_too_large');
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  return stat.size;
}

export async function copyCharacterDirectory(
  source: string,
  destination: string,
): Promise<number> {
  const stat = await fs.promises.stat(source).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new CharacterResourceValidationError('source_directory_required');
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    dereference: true,
  });
  return directoryBytes(destination);
}

export async function exportCharacterResource(
  source: string,
  destinationDirectory: string,
  targetName: string,
): Promise<string> {
  const destination = await fs.promises.stat(destinationDirectory).catch(() => null);
  if (!destination?.isDirectory()) {
    throw new CharacterResourceValidationError('destination_directory_required');
  }
  const sourceStat = await fs.promises.stat(source).catch(() => null);
  const safeName = toExportName(targetName);
  const target = sourceStat?.isFile()
    ? path.join(destinationDirectory, `${safeName}${path.extname(source)}`)
    : path.join(destinationDirectory, safeName);
  if (sourceStat?.isDirectory()) await copyCharacterDirectory(source, target);
  else if (sourceStat?.isFile()) await copyCharacterFile(source, target);
  else throw new CharacterResourceValidationError('resource_type_unsupported');
  return target;
}

function toExportName(name: string): string {
  const normalized = name.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').trim();
  if (!normalized || normalized === '.' || normalized === '..') return 'resource';
  return normalized;
}

async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile()) bytes += (await fs.promises.stat(absolutePath)).size;
    }
  }
  await walk(root);
  return bytes;
}
