// 流式解压 Session ZIP，并在写盘时检查条目白名单和压缩炸弹。
import fs from 'node:fs';
import path from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import type { BackupArchiveSource } from '../types.js';
import { SessionImportError } from '../errors.js';
import { isSessionArchivePath } from '../records/sessionFormat.js';
import { normalizeArchivePath, resolveInside } from './pathPolicy.js';

// 单人本地导入的真防线只有一条:总展开体积(防 zip 炸弹撑爆磁盘/内存)。
// 条目数/压缩比等分项纵深不建——包是用户自己导出的,威胁模型里没有攻击者。
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024;

export interface ExtractedEntry {
  readonly path: string;
  readonly filePath: string;
  readonly size: number;
}

export class ExtractedSessionArchive {
  constructor(
    readonly directory: string,
    private readonly entries: ReadonlyMap<string, ExtractedEntry>,
  ) {}

  get(entryPath: string): ExtractedEntry | null {
    return this.entries.get(entryPath) ?? null;
  }

  require(entryPath: string): ExtractedEntry {
    const entry = this.get(entryPath);
    if (!entry) throw new SessionImportError('invalid_format', `备份缺少 ${entryPath}`);
    return entry;
  }

  paths(): readonly string[] {
    return [...this.entries.keys()].sort();
  }

  dispose(): void {
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}

export async function extractSessionArchive(
  source: BackupArchiveSource,
  temporaryRoot: string,
  signal?: AbortSignal,
): Promise<ExtractedSessionArchive> {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'session-'));
  const entries = new Map<string, ExtractedEntry>();
  const portablePaths = new Set<string>();
  const openFiles = new Set<number>();
  let archiveBytes = 0;
  let expandedBytes = 0;

  try {
    const unzip = new Unzip(file => {
      const entryPath = normalizeArchivePath(file.name);
      if (!isSessionArchivePath(entryPath)) {
        throw new SessionImportError('invalid_format', `ZIP 包含未知条目: ${entryPath}`);
      }
      const portable = entryPath.toLocaleLowerCase('en-US');
      if (portablePaths.has(portable)) {
        throw new SessionImportError('invalid_format', `ZIP 存在同名路径: ${entryPath}`);
      }
      portablePaths.add(portable);
      const destination = resolveInside(directory, entryPath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      let descriptor: number | null = fs.openSync(destination, 'wx');
      openFiles.add(descriptor);
      let entryBytes = 0;
      file.ondata = (error, chunk, final) => {
        if (error) throw new SessionImportError('invalid_zip', `ZIP 条目损坏: ${entryPath}`);
        entryBytes += chunk.byteLength;
        expandedBytes += chunk.byteLength;
        if (expandedBytes > MAX_EXPANDED_BYTES) {
          throw new SessionImportError('archive_bomb', 'ZIP 展开体积异常');
        }
        if (descriptor !== null && chunk.byteLength > 0) fs.writeSync(descriptor, chunk);
        if (!final) return;
        if (descriptor !== null) {
          fs.closeSync(descriptor);
          openFiles.delete(descriptor);
          descriptor = null;
        }
        entries.set(entryPath, { path: entryPath, filePath: destination, size: entryBytes });
      };
      file.start();
    });
    unzip.register(UnzipInflate);

    for await (const chunk of source.chunks()) {
      if (signal?.aborted) throw new SessionImportError('import_cancelled', 'Session 导入已取消');
      archiveBytes += chunk.byteLength;
      unzip.push(chunk, false);
    }
    unzip.push(new Uint8Array(), true);
    if (openFiles.size > 0) throw new SessionImportError('invalid_zip', 'ZIP 存在未完成条目');
    if (source.declaredBytes !== null && source.declaredBytes !== archiveBytes) {
      throw new SessionImportError('invalid_zip', 'ZIP 实际字节数与声明不一致');
    }
    return new ExtractedSessionArchive(directory, entries);
  } catch (error) {
    for (const descriptor of openFiles) {
      try { fs.closeSync(descriptor); } catch { /* 文件可能已由解压回调关闭。 */ }
    }
    fs.rmSync(directory, { recursive: true, force: true });
    if (error instanceof SessionImportError) throw error;
    throw new SessionImportError('invalid_zip', error instanceof Error ? error.message : 'ZIP 无法解压');
  }
}
