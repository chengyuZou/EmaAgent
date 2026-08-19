// 把 Live2D ZIP 直接解压到稳定目录，或把已展开目录流式导出为 ZIP。

import fs from 'node:fs';
import path from 'node:path';
import { Unzip, UnzipInflate, Zip, ZipDeflate } from 'fflate';
import { CharacterResourceValidationError } from '../errors.js';
import type { CharacterSettings } from '../settings.js';
import { physicalName, sourceBaseName } from '../resources/resourcePaths.js';
import { removeDirectoryIfPresent, removeFileIfPresent } from '../resources/resourceFiles.js';

export interface ImportedLive2dFiles {
  readonly directoryName: string;
  readonly displayName: string;
  readonly byteSize: number;
}

export async function importLive2dZip(
  sourceZipFile: string,
  destinationRoot: string,
  limits: CharacterSettings['live2d'],
): Promise<ImportedLive2dFiles> {
  const source = await fs.promises.stat(sourceZipFile).catch(() => null);
  if (!source?.isFile() || path.extname(sourceZipFile).toLowerCase() !== '.zip') {
    throw new CharacterResourceValidationError('source_zip_required');
  }
  const directoryName = sourceBaseName(sourceZipFile);
  const destination = path.join(destinationRoot, directoryName);
  if (fs.existsSync(destination)) {
    throw new CharacterResourceValidationError('resource_name_conflict');
  }
  await fs.promises.mkdir(destinationRoot, { recursive: true });

  try {
    const byteSize = await extractZip(sourceZipFile, destination, limits);
    return { directoryName, displayName: directoryName, byteSize };
  } catch (error) {
    await removeDirectoryIfPresent(destination);
    throw error;
  }
}

export async function exportLive2dZip(
  sourceDirectory: string,
  destinationDirectory: string,
  displayName: string,
  limits: CharacterSettings['live2d'],
): Promise<string> {
  const destination = await fs.promises.stat(destinationDirectory).catch(() => null);
  if (!destination?.isDirectory()) {
    throw new CharacterResourceValidationError('destination_directory_required');
  }
  const target = path.join(destinationDirectory, `${physicalName(displayName.trim())}.zip`);
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, 'wx');
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new CharacterResourceValidationError('export_destination_exists');
    }
    throw error;
  }

  try {
    const files = await listFiles(sourceDirectory);
    if (files.length > limits.maxZipEntries) {
      throw new CharacterResourceValidationError('zip_entry_count_exceeded');
    }
    let expandedBytes = 0;
    const zip = new Zip((error, chunk) => {
      if (error) throw error;
      if (chunk.byteLength > 0) fs.writeSync(descriptor, chunk);
    });
    for (const file of files) {
      const stat = await fs.promises.stat(file);
      expandedBytes += stat.size;
      if (expandedBytes > limits.maxZipTotalBytes) {
        throw new CharacterResourceValidationError('zip_expanded_size_exceeded');
      }
      const entry = new ZipDeflate(
        path.relative(sourceDirectory, file).split(path.sep).join('/'),
        { level: 6 },
      );
      zip.add(entry);
      for await (const chunk of fs.createReadStream(file)) {
        entry.push(chunk);
      }
      entry.push(new Uint8Array(), true);
    }
    zip.end();
    fs.closeSync(descriptor);
    return target;
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* 已关闭时无需二次处理。 */ }
    await removeFileIfPresent(target);
    if (error instanceof CharacterResourceValidationError) throw error;
    throw new CharacterResourceValidationError('zip_invalid');
  }
}

export { removeDirectoryIfPresent as deleteLive2dDirectory };

async function extractZip(
  sourceZipFile: string,
  destination: string,
  limits: CharacterSettings['live2d'],
): Promise<number> {
  await fs.promises.mkdir(destination, { recursive: false });
  const openFiles = new Set<number>();
  let entryCount = 0;
  let expandedBytes = 0;
  try {
    const unzip = new Unzip((file) => {
      const entryPath = normalizeEntryPath(file.name);
      entryCount += 1;
      if (entryCount > limits.maxZipEntries) {
        throw new CharacterResourceValidationError('zip_entry_count_exceeded');
      }
      if (
        file.originalSize !== undefined
        && file.originalSize > limits.maxZipTotalBytes
      ) {
        throw new CharacterResourceValidationError('zip_expanded_size_exceeded');
      }
      const isDirectory = entryPath.endsWith('/');
      const target = path.join(destination, ...entryPath.split('/').filter(Boolean));
      if (isDirectory) fs.mkdirSync(target, { recursive: true });
      else fs.mkdirSync(path.dirname(target), { recursive: true });
      let descriptor: number | null = isDirectory ? null : fs.openSync(target, 'wx');
      if (descriptor !== null) openFiles.add(descriptor);
      file.ondata = (error, chunk, final) => {
        if (error) throw new CharacterResourceValidationError('zip_invalid');
        expandedBytes += chunk.byteLength;
        if (expandedBytes > limits.maxZipTotalBytes) {
          throw new CharacterResourceValidationError('zip_expanded_size_exceeded');
        }
        if (descriptor !== null && chunk.byteLength > 0) fs.writeSync(descriptor, chunk);
        if (final && descriptor !== null) {
          fs.closeSync(descriptor);
          openFiles.delete(descriptor);
          descriptor = null;
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for await (const chunk of fs.createReadStream(sourceZipFile)) {
      unzip.push(chunk, false);
    }
    unzip.push(new Uint8Array(), true);
    if (openFiles.size > 0) {
      throw new CharacterResourceValidationError('zip_invalid');
    }
    return expandedBytes;
  } catch (error) {
    for (const descriptor of openFiles) {
      try { fs.closeSync(descriptor); } catch { /* 清理阶段忽略重复关闭。 */ }
    }
    if (error instanceof CharacterResourceValidationError) throw error;
    throw new CharacterResourceValidationError('zip_invalid');
  }
}

function normalizeEntryPath(value: string): string {
  const parts = value.replace(/\/$/u, '').split('/');
  if (
    !value
    || value.includes('\\')
    || value.startsWith('/')
    || /^[a-z]:/iu.test(value)
    || parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new CharacterResourceValidationError('zip_entry_path_invalid');
  }
  return value;
}

async function listFiles(root: string): Promise<string[]> {
  const stat = await fs.promises.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new CharacterResourceValidationError('resource_type_unsupported');
  }
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
    }
  }
  await walk(root);
  return files.sort();
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
