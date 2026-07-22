// 后台按 TTL、单 Session 配额和全局配额回收已经外置的工具结果文件。
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CleanerConfig {
  ttlDays: number;
  perSessionMaxBytes: number;
  globalMaxBytes: number;
}

export const DEFAULT_CLEANER_CONFIG: CleanerConfig = {
  ttlDays: 7,
  perSessionMaxBytes: 50 * 1024 * 1024,
  globalMaxBytes: 500 * 1024 * 1024,
};

interface FileEntry {
  fullPath: string;
  size: number;
  mtimeMs: number;
}

export class ToolResultCleaner {
  private readonly sessionRoots: readonly string[];

  constructor(
    sessionsDirs: string | readonly string[],
    private readonly config: CleanerConfig = DEFAULT_CLEANER_CONFIG,
  ) {
    this.sessionRoots = typeof sessionsDirs === 'string' ? [sessionsDirs] : [...sessionsDirs];
  }

  sweep(): { deleted: number; freedBytes: number } {
    let deleted = 0;
    let freedBytes = 0;
    const allFiles: FileEntry[] = [];
    const now = Date.now();
    const ttlMs = this.config.ttlDays * 24 * 60 * 60 * 1000;

    for (const directory of this.listSessionToolResultDirs()) {
      const files = this.listFiles(directory);
      const sessionDir = path.dirname(directory);
      let sessionActive = false;
      try {
        sessionActive = now - fs.statSync(sessionDir).mtimeMs < ttlMs;
      } catch {
        // Session 目录已删除时按非活跃处理，后续文件操作保持容错。
      }

      const survivors: FileEntry[] = [];
      for (const file of files) {
        if (!sessionActive && now - file.mtimeMs > ttlMs) {
          if (this.remove(file.fullPath)) {
            deleted += 1;
            freedBytes += file.size;
          }
        } else {
          survivors.push(file);
        }
      }

      const sessionQuota = this.enforceQuota(survivors, this.config.perSessionMaxBytes);
      deleted += sessionQuota.deleted;
      freedBytes += sessionQuota.freedBytes;
      allFiles.push(...sessionQuota.remaining);
    }

    const globalQuota = this.enforceQuota(allFiles, this.config.globalMaxBytes);
    return {
      deleted: deleted + globalQuota.deleted,
      freedBytes: freedBytes + globalQuota.freedBytes,
    };
  }

  private enforceQuota(files: FileEntry[], maxBytes: number): {
    deleted: number;
    freedBytes: number;
    remaining: FileEntry[];
  } {
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes <= maxBytes) {
      return { deleted: 0, freedBytes: 0, remaining: files };
    }

    const sorted = [...files].sort(
      (left, right) => left.mtimeMs - right.mtimeMs || left.fullPath.localeCompare(right.fullPath),
    );
    const remaining: FileEntry[] = [];
    let deleted = 0;
    let freedBytes = 0;
    for (const file of sorted) {
      if (totalBytes > maxBytes && this.remove(file.fullPath)) {
        deleted += 1;
        freedBytes += file.size;
        totalBytes -= file.size;
      } else {
        remaining.push(file);
      }
    }
    return { deleted, freedBytes, remaining };
  }

  private listSessionToolResultDirs(): string[] {
    const directories: string[] = [];
    for (const root of this.sessionRoots) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      directories.push(...entries
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(root, entry.name, 'tool-results'))
        .filter(directory => fs.existsSync(directory)));
    }
    return directories;
  }

  private listFiles(directory: string): FileEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch {
      return [];
    }

    const files: FileEntry[] = [];
    for (const name of names) {
      const fullPath = path.join(directory, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) files.push({ fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Cleaner 与工具执行并发时文件可能已经消失。
      }
    }
    return files;
  }

  private remove(fullPath: string): boolean {
    try {
      fs.rmSync(fullPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}
