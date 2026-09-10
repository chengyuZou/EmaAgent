// 后台按 TTL、单 Session 配额和全局配额回收已经外置落盘的工具结果文件。
import { readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';

const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const PER_SESSION_MAX_BYTES = 50 * 1024 * 1024;
const GLOBAL_MAX_BYTES = 500 * 1024 * 1024;
const FILE_IO_CONCURRENCY = 8;

interface ToolResultCleanup {
  deleted: number;
  freedBytes: number;
}

interface FileEntry {
  fullPath: string;
  size: number;
  mtimeMs: number;
}

export class ToolResultCleaner {
  constructor(private readonly sessionsDir: string) {}

  /**
   * 先按结果文件自己的修改时间清 TTL, 再依次约束单 Session 与全局体积.
   * 扫描和删除都限制为 8 路文件 I/O, 避免大量历史 Session 在低配机器上形成 I/O 峰值.
   */
  async sweep(): Promise<ToolResultCleanup> {
    let deleted = 0;
    let freedBytes = 0;
    const allFiles: FileEntry[] = [];
    const expiresBefore = Date.now() - RESULT_TTL_MS;

    for (const directory of await this.listSessionToolResultDirs()) {
      const files = await this.listFiles(directory);
      const expired = files.filter(file => file.mtimeMs < expiresBefore);
      const ttlCleanup = await this.removeFiles(expired);
      deleted += ttlCleanup.deleted;
      freedBytes += ttlCleanup.freedBytes;

      // 删除失败的过期文件仍然占磁盘, 必须继续进入配额计算.
      const survivors = files.filter(file => !ttlCleanup.removedPaths.has(file.fullPath));
      const sessionCleanup = await this.enforceQuota(survivors, PER_SESSION_MAX_BYTES);
      deleted += sessionCleanup.deleted;
      freedBytes += sessionCleanup.freedBytes;
      allFiles.push(...sessionCleanup.remaining);
    }

    const globalCleanup = await this.enforceQuota(allFiles, GLOBAL_MAX_BYTES);
    return {
      deleted: deleted + globalCleanup.deleted,
      freedBytes: freedBytes + globalCleanup.freedBytes,
    };
  }

  private async enforceQuota(
    files: readonly FileEntry[],
    maxBytes: number,
  ): Promise<ToolResultCleanup & { remaining: FileEntry[] }> {
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes <= maxBytes) {
      return { deleted: 0, freedBytes: 0, remaining: [...files] };
    }

    const oldestFirst = [...files].sort(
      (left, right) => left.mtimeMs - right.mtimeMs || left.fullPath.localeCompare(right.fullPath),
    );
    const removedPaths = new Set<string>();
    let deleted = 0;
    let freedBytes = 0;
    let cursor = 0;

    while (totalBytes > maxBytes && cursor < oldestFirst.length) {
      const batch: FileEntry[] = [];
      let projectedBytes = totalBytes;
      while (
        projectedBytes > maxBytes
        && cursor < oldestFirst.length
        && batch.length < FILE_IO_CONCURRENCY
      ) {
        const file = oldestFirst[cursor];
        cursor += 1;
        if (!file) break;
        batch.push(file);
        projectedBytes -= file.size;
      }

      const cleanup = await this.removeFiles(batch);
      deleted += cleanup.deleted;
      freedBytes += cleanup.freedBytes;
      totalBytes -= cleanup.freedBytes;
      for (const fullPath of cleanup.removedPaths) removedPaths.add(fullPath);
    }

    return {
      deleted,
      freedBytes,
      remaining: files.filter(file => !removedPaths.has(file.fullPath)),
    };
  }

  private async listSessionToolResultDirs(): Promise<string[]> {
    try {
      const entries = await readdir(this.sessionsDir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(this.sessionsDir, entry.name, 'tool-results'));
    } catch {
      return [];
    }
  }

  private async listFiles(directory: string): Promise<FileEntry[]> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }

    const files: FileEntry[] = [];
    for (let offset = 0; offset < names.length; offset += FILE_IO_CONCURRENCY) {
      const batch = names.slice(offset, offset + FILE_IO_CONCURRENCY);
      const entries = await Promise.all(batch.map(async (name): Promise<FileEntry | undefined> => {
        const fullPath = path.join(directory, name);
        try {
          const fileStat = await stat(fullPath);
          return fileStat.isFile()
            ? { fullPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs }
            : undefined;
        } catch {
          // 清理与 Session 删除或 Tool 写入并发时, 文件可能已经消失.
          return undefined;
        }
      }));
      for (const entry of entries) {
        if (entry) files.push(entry);
      }
    }
    return files;
  }

  private async removeFiles(files: readonly FileEntry[]): Promise<
    ToolResultCleanup & { removedPaths: ReadonlySet<string> }
  > {
    const removedPaths = new Set<string>();
    let deleted = 0;
    let freedBytes = 0;

    for (let offset = 0; offset < files.length; offset += FILE_IO_CONCURRENCY) {
      const batch = files.slice(offset, offset + FILE_IO_CONCURRENCY);
      const outcomes = await Promise.all(batch.map(async (file) => {
        try {
          await rm(file.fullPath, { force: true });
          return true;
        } catch {
          return false;
        }
      }));
      outcomes.forEach((removed, index) => {
        if (!removed) return;
        const file = batch[index];
        if (!file) return;
        removedPaths.add(file.fullPath);
        deleted += 1;
        freedBytes += file.size;
      });
    }

    return { deleted, freedBytes, removedPaths };
  }
}
