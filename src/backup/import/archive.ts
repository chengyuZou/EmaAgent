import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Open } from 'unzipper';
import { SessionImportError } from '../errors.js';
import { normalizeArchivePath, resolveInside } from './pathPolicy.js';

// 直接读取磁盘上的 ZIP 不限制压缩文件大小, 但解压不能无限占用磁盘.
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024;

export interface ExtractedEntry {
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
    if (!entry) {
      throw new SessionImportError('invalid_format', `备份缺少 ${entryPath}`);
    }
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
  filePath: string,
  temporaryRoot: string,
  signal?: AbortSignal,
): Promise<ExtractedSessionArchive> {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'session-'));
  const entries = new Map<string, ExtractedEntry>();
  const portablePaths = new Set<string>();
  let expandedBytes = 0;

  try {
    signal?.throwIfAborted();
    // Open.file 读取 ZIP 目录和各条目的文件范围, 不把整个 ZIP 读入内存.
    const zip = await Open.file(filePath);
    for (const file of zip.files) {
      signal?.throwIfAborted();
      const entryPath = normalizeArchivePath(file.path);
      const destination = resolveInside(directory, entryPath);
      if (file.type === 'Directory') {
        continue;
      }
      const portable = entryPath.toLocaleLowerCase('en-US');
      if (portablePaths.has(portable)) {
        throw new SessionImportError('invalid_format', `ZIP 存在同名路径: ${entryPath}`);
      }
      portablePaths.add(portable);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      let entryBytes = 0;
      const measure = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          entryBytes += chunk.byteLength;
          expandedBytes += chunk.byteLength;
          if (expandedBytes > MAX_EXPANDED_BYTES) {
            callback(new SessionImportError('archive_bomb', `ZIP 展开体积超过 ${MAX_EXPANDED_BYTES / (1024 ** 3)} GiB`, 413));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(file.stream(), measure, fs.createWriteStream(destination, { flags: 'wx' }), { signal });
      if (entryBytes !== file.uncompressedSize) {
        throw new SessionImportError('invalid_zip', `ZIP 条目字节数不完整: ${entryPath}`);
      }
      entries.set(entryPath, { filePath: destination, size: entryBytes });
    }
    signal?.throwIfAborted();
    return new ExtractedSessionArchive(directory, entries);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    if (signal?.aborted) {
      throw new SessionImportError('import_cancelled', 'Session 导入已取消', 499);
    }
    if (error instanceof SessionImportError) {
      throw error;
    }
    throw new SessionImportError('invalid_zip', error instanceof Error ? error.message : 'ZIP 无法解压');
  }
}
