// 执行用户明确选择的 Memory 文件清除操作.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function clearAllMemory(memoryRoot: string): Promise<void> {
  await fs.mkdir(memoryRoot, { recursive: true });
  await clearDirectoryEntries(memoryRoot);
}

export async function clearMemoryDirectory(
  memoryRoot: string,
  relativeDirectory: string,
): Promise<void> {
  const directory = resolveInsideMemoryRoot(memoryRoot, relativeDirectory);
  const stat = await readFileStat(directory);
  if (stat === undefined) return;
  if (!stat.isDirectory()) {
    throw new Error(`Memory clear target is not a directory: ${relativeDirectory}`);
  }
  await clearDirectoryEntries(directory);
}

export async function clearMemoryFiles(
  memoryRoot: string,
  relativeFiles: readonly string[],
): Promise<void> {
  for (const relativeFile of relativeFiles) {
    const file = resolveInsideMemoryRoot(memoryRoot, relativeFile);
    const stat = await readFileStat(file);
    if (stat === undefined) {
      continue;
    }
    if (stat.isDirectory()) {
      throw new Error(`Memory clear target is not a file: ${relativeFile}`);
    }
    await fs.rm(file, { force: true });
  }
}

function resolveInsideMemoryRoot(
  memoryRoot: string,
  relativePath: string,
): string {
  if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new RangeError(`Memory path must be relative: ${relativePath}`);
  }

  const root = path.resolve(memoryRoot);
  const target = path.resolve(root, relativePath);
  const relation = path.relative(root, target);
  if (relation === '' || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new RangeError(`Memory path is outside the root: ${relativePath}`);
  }
  return target;
}

async function clearDirectoryEntries(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory)) {
    await fs.rm(path.join(directory, entry), { recursive: true, force: true });
  }
}

async function readFileStat(
  filePath: string,
): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
