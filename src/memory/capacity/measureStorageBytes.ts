import { promises as fs, Dir, Stats } from 'node:fs';
import path from 'node:path';

export async function measureMemoryStorageBytes(
  memoryRoot: string,
): Promise<number> {
  const directories = [memoryRoot];
  let bytes = 0;

  while (directories.length > 0) {
    const directory = directories.pop()!;
    const handle = await openDirectory(directory);
    if (handle === undefined) {
      continue;
    }

    for await (const entry of handle) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(entryPath);
        continue;
      }

      // lstat 统计链接本身, 不沿链接读取目录外的数据; .git 也计入实际占用.
      const stat = await readEntryStat(entryPath);
      if (stat !== undefined) {
        bytes += stat.size;
      }
    }
  }

  return bytes;
}

async function openDirectory(
  directory: string,
): Promise<Dir | undefined> {
  try {
    return await fs.opendir(directory);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function readEntryStat(
  entryPath: string,
): Promise<Stats | undefined> {
  try {
    return await fs.lstat(entryPath);
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
