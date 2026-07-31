// 流式接收并解压 Session ZIP，在落盘前执行路径白名单、体积和压缩比安全检查。
import fs from 'node:fs';
import path from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import type { BackupArchiveSource } from '../types.js';
import { BACKUP_LIMITS, type BackupLimits } from '../limits.js';
import {
  BACKUP_FILE_ROOTS,
  BACKUP_INTEGRITY_PATH,
  BACKUP_MANIFEST_PATH,
  BACKUP_RECORD_PATHS,
} from '../records/recordRegistry.js';
import { SessionImportError } from './errors.js';
import { normalizeArchiveEntryName, resolvePathInside } from './path-policy.js';

export interface ExtractedArchiveEntry {
  readonly path: string;
  readonly filePath: string;
  readonly size: number;
}

export class ExtractedSessionArchive {
  constructor(
    readonly stagingDir: string,
    private readonly entries: ReadonlyMap<string, ExtractedArchiveEntry>,
  ) {}

  get(path: string): ExtractedArchiveEntry | null {
    return this.entries.get(path) ?? null;
  }

  require(path: string): ExtractedArchiveEntry {
    const entry = this.entries.get(path);
    if (!entry) throw new SessionImportError('invalid_format', `备份缺少 ${path}`);
    return entry;
  }

  paths(): readonly string[] {
    return [...this.entries.keys()].sort();
  }

  dispose(): void {
    fs.rmSync(this.stagingDir, { recursive: true, force: true });
  }
}

export async function extractSessionArchive(
  source: BackupArchiveSource,
  stagingRoot: string,
  signal?: AbortSignal,
  limits: BackupLimits = BACKUP_LIMITS,
): Promise<ExtractedSessionArchive> {
  if (source.declaredSize !== null && source.declaredSize > limits.maxArchiveBytes) {
    throw new SessionImportError('archive_too_large', 'ZIP 文件超过导入大小限制', 413);
  }
  fs.mkdirSync(stagingRoot, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(stagingRoot, 'session-import-'));
  const entries = new Map<string, ExtractedArchiveEntry>();
  const portableNames = new Set<string>();
  const openFiles = new Set<number>();
  let archiveBytes = 0;
  let expandedBytes = 0;
  let entryCount = 0;

  try {
    const unzip = new Unzip((file) => {
      const entryPath = normalizeArchiveEntryName(file.name);
      if (!isAllowedPath(entryPath)) {
        throw new SessionImportError('invalid_format', `ZIP 包含未知条目: ${entryPath}`);
      }
      const portableName = entryPath.toLocaleLowerCase('en-US');
      if (portableNames.has(portableName)) {
        throw new SessionImportError('invalid_format', `ZIP 存在可移植路径冲突: ${entryPath}`);
      }
      portableNames.add(portableName);
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw new SessionImportError('too_many_entries', 'ZIP 文件数量超过限制', 413);
      }
      if (file.originalSize !== undefined && file.originalSize > limits.maxEntryBytes) {
        throw new SessionImportError('entry_too_large', `ZIP 条目过大: ${entryPath}`, 413);
      }
      if (
        file.size !== undefined
        && file.originalSize !== undefined
        && file.originalSize > 0
        && file.originalSize / Math.max(file.size, 1) > limits.maxCompressionRatio
      ) {
        throw new SessionImportError('compression_ratio_too_high', `ZIP 条目压缩比异常: ${entryPath}`, 413);
      }

      const isDirectory = entryPath.endsWith('/');
      const destination = resolvePathInside(
        stagingDir,
        ...entryPath.split('/').filter(Boolean),
      );
      if (isDirectory) fs.mkdirSync(destination, { recursive: true });
      else fs.mkdirSync(path.dirname(destination), { recursive: true });

      let entryBytes = 0;
      let descriptor: number | null = isDirectory ? null : fs.openSync(destination, 'wx');
      if (descriptor !== null) openFiles.add(descriptor);
      file.ondata = (error, chunk, final) => {
        if (error) throw new SessionImportError('invalid_zip', `ZIP 条目损坏: ${entryPath}`);
        entryBytes += chunk.byteLength;
        expandedBytes += chunk.byteLength;
        if (entryBytes > limits.maxEntryBytes) {
          throw new SessionImportError('entry_too_large', `ZIP 条目过大: ${entryPath}`, 413);
        }
        if (expandedBytes > limits.maxExpandedBytes) {
          throw new SessionImportError('expanded_size_too_large', 'ZIP 展开后总体积超过限制', 413);
        }
        if (descriptor !== null && chunk.byteLength > 0) fs.writeSync(descriptor, chunk);
        if (!final) return;
        if (descriptor !== null) {
          fs.closeSync(descriptor);
          openFiles.delete(descriptor);
          descriptor = null;
        }
        if (!isDirectory) {
          entries.set(entryPath, { path: entryPath, filePath: destination, size: entryBytes });
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);

    for await (const chunk of source.chunks()) {
      if (signal?.aborted) throw new SessionImportError('import_cancelled', 'Session 导入已取消');
      archiveBytes += chunk.byteLength;
      if (archiveBytes > limits.maxArchiveBytes) {
        throw new SessionImportError('archive_too_large', 'ZIP 文件超过导入大小限制', 413);
      }
      unzip.push(chunk, false);
    }
    unzip.push(new Uint8Array(), true);

    if (source.declaredSize !== null && archiveBytes !== source.declaredSize) {
      throw new SessionImportError('invalid_format', '上传数据长度与声明大小不一致');
    }
    if (openFiles.size > 0) {
      throw new SessionImportError('invalid_zip', 'ZIP 提前结束，存在未完成条目');
    }
    if (
      expandedBytes > 0
      && expandedBytes / Math.max(archiveBytes, 1) > limits.maxCompressionRatio
    ) {
      throw new SessionImportError('compression_ratio_too_high', 'ZIP 总压缩比异常', 413);
    }
    return new ExtractedSessionArchive(stagingDir, entries);
  } catch (error) {
    for (const descriptor of openFiles) {
      try { fs.closeSync(descriptor); } catch { /* 清理阶段忽略重复关闭。 */ }
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (error instanceof SessionImportError) throw error;
    throw new SessionImportError('invalid_zip', '无法解压 ZIP 文件');
  }
}

function isAllowedPath(entryPath: string): boolean {
  if (
    entryPath === BACKUP_MANIFEST_PATH
    || entryPath === BACKUP_INTEGRITY_PATH
    || BACKUP_RECORD_PATHS.has(entryPath)
  ) {
    return true;
  }
  const parts = entryPath.replace(/\/$/, '').split('/');
  return parts.length >= 3
    && parts[0] === 'files'
    && BACKUP_FILE_ROOTS.has(parts[1]!)
    && parts.slice(2).every(part => part.length > 0 && part !== '.' && part !== '..');
}
