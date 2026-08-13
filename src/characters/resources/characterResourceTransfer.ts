// 以流式、有界且不跟随链接的方式复制角色文件和目录，并返回实际字节数。

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { CharacterResourceValidationError } from '../errors.js';

export interface CopiedResource {
  readonly byteSize: number;
}

export interface DirectoryCopyLimits {
  readonly maxFiles: number;
  readonly maxSingleFileBytes: number;
  readonly maxTotalBytes: number;
}

export async function copyFileBounded(
  source: string,
  destination: string,
  maxBytes: number,
): Promise<CopiedResource> {
  const before = await assertRegularSourceFile(source, maxBytes);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  let copied = 0;
  const observer = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      copied += chunk.byteLength;
      if (copied > maxBytes) {
        callback(new CharacterResourceValidationError('resource_too_large'));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      fs.createReadStream(source),
      observer,
      fs.createWriteStream(destination, { flags: 'wx' }),
    );
    const after = await fs.promises.stat(source);
    if (
      after.size !== before.size
      || Math.trunc(after.mtimeMs) !== Math.trunc(before.mtimeMs)
    ) {
      throw new CharacterResourceValidationError('source_changed_during_copy');
    }
    return { byteSize: copied };
  } catch (error) {
    await fs.promises.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function copyDirectoryBounded(
  source: string,
  destination: string,
  limits: DirectoryCopyLimits,
): Promise<CopiedResource> {
  const root = await fs.promises.lstat(source);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new CharacterResourceValidationError('source_directory_required');
  }

  const entries = await collectDirectoryFiles(source, limits);
  await fs.promises.mkdir(destination, { recursive: false });
  let total = 0;
  try {
    for (const entry of entries) {
      const target = path.join(destination, ...entry.relativePath.split('/'));
      const copied = await copyFileBounded(
        entry.absolutePath,
        target,
        limits.maxSingleFileBytes,
      );
      total += copied.byteSize;
      if (total > limits.maxTotalBytes) {
        throw new CharacterResourceValidationError('resource_directory_too_large');
      }
    }
    const after = await collectDirectoryFiles(source, limits);
    if (
      after.length !== entries.length
      || after.some((entry, index) => {
        const before = entries[index];
        return entry.relativePath !== before?.relativePath
          || entry.byteSize !== before.byteSize
          || entry.mtimeMs !== before.mtimeMs;
      })
    ) {
      throw new CharacterResourceValidationError('source_changed_during_copy');
    }
    return { byteSize: total };
  } catch (error) {
    await fs.promises.rm(destination, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }
}

export async function exportPathAtomically(
  source: string,
  destinationDirectory: string,
  targetName: string,
  limits: DirectoryCopyLimits & { maxFileBytes: number },
): Promise<string> {
  const destinationStat = await fs.promises.lstat(destinationDirectory);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new CharacterResourceValidationError('destination_directory_required');
  }
  assertPortableName(targetName);
  const target = path.join(destinationDirectory, targetName);
  if (fs.existsSync(target)) {
    throw new CharacterResourceValidationError('export_destination_exists');
  }
  const temporary = path.join(
    destinationDirectory,
    `.${targetName}.ema-export-${process.pid}-${Date.now()}`,
  );
  const sourceStat = await fs.promises.lstat(source);
  try {
    if (sourceStat.isSymbolicLink()) {
      throw new CharacterResourceValidationError('symbolic_link_not_allowed');
    }
    if (sourceStat.isDirectory()) {
      await copyDirectoryBounded(source, temporary, limits);
    } else if (sourceStat.isFile()) {
      await copyFileBounded(source, temporary, limits.maxFileBytes);
    } else {
      throw new CharacterResourceValidationError('resource_type_unsupported');
    }
    await fs.promises.rename(temporary, target);
    return target;
  } catch (error) {
    await fs.promises.rm(temporary, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }
}

async function assertRegularSourceFile(
  source: string,
  maxBytes: number,
): Promise<fs.Stats> {
  const stat = await fs.promises.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CharacterResourceValidationError('source_file_required');
  }
  if (stat.size > maxBytes) {
    throw new CharacterResourceValidationError('resource_too_large');
  }
  return stat;
}

async function collectDirectoryFiles(
  root: string,
  limits: DirectoryCopyLimits,
): Promise<Array<{
  relativePath: string;
  absolutePath: string;
  byteSize: number;
  mtimeMs: number;
}>> {
  const files: Array<{
    relativePath: string;
    absolutePath: string;
    byteSize: number;
    mtimeMs: number;
  }> = [];
  const caseFolded = new Set<string>();
  let totalBytes = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertPortableName(entry.name);
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      const folded = relativePath.toLocaleLowerCase('en-US');
      if (caseFolded.has(folded)) {
        throw new CharacterResourceValidationError('case_fold_path_collision');
      }
      caseFolded.add(folded);
      const stat = await fs.promises.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new CharacterResourceValidationError('symbolic_link_not_allowed');
      }
      if (stat.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new CharacterResourceValidationError('resource_type_unsupported');
      }
      if (stat.size > limits.maxSingleFileBytes) {
        throw new CharacterResourceValidationError('resource_too_large');
      }
      totalBytes += stat.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new CharacterResourceValidationError('resource_directory_too_large');
      }
      files.push({
        relativePath,
        absolutePath,
        byteSize: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      });
      if (files.length > limits.maxFiles) {
        throw new CharacterResourceValidationError('resource_file_count_exceeded');
      }
    }
  }

  await walk(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function assertPortableName(value: string): void {
  if (
    !value
    || value === '.'
    || value === '..'
    || /[<>:"/\\|?*\u0000-\u001f]/u.test(value)
    || /[. ]$/u.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(value)
  ) {
    throw new CharacterResourceValidationError('resource_name_not_portable');
  }
}
