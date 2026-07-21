// 在路径、条目和解压预算约束下提取 Session 备份归档。
import fs from 'node:fs';
import path from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import { SessionImportError } from './errors.js';
import { normalizeArchiveEntryName, resolvePathInside } from './path-policy.js';

const MiB = 1024 * 1024;

export interface SessionImportLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
  maxJsonBytes: number;
  maxJsonTotalBytes: number;
  maxCompressionRatio: number;
}

/** V1 只承诺受限的单 Session ZIP；超大 JSONL/分卷属于 ZIP v2。 */
export const SESSION_IMPORT_LIMITS: Readonly<SessionImportLimits> = {
  maxArchiveBytes: 256 * MiB,
  maxEntries: 10_000,
  maxEntryBytes: 256 * MiB,
  maxExpandedBytes: 1024 * MiB,
  maxJsonBytes: 64 * MiB,
  maxJsonTotalBytes: 128 * MiB,
  maxCompressionRatio: 500,
};

const ROOT_JSON_ENTRIES = new Set([
  'manifest.json', 'session.json', 'turns.json', 'messages.json', 'branches.json',
  'agent_tasks.json', 'agent_task_messages.json', 'memory_state.json',
  'kb_activations.json', 'usage_records.json', 'llm_turn_metrics.json', 'usage.json', 'notes.json',
  'artifacts/index.json', 'audio/index.json', 'attachments/index.json',
]);
const CONTENT_ROOTS = new Set(['artifacts', 'audio', 'attachments']);

function isAllowedEntry(name: string): boolean {
  if (ROOT_JSON_ENTRIES.has(name)) return true;
  if (name.endsWith('/')) return CONTENT_ROOTS.has(name.slice(0, -1));
  const slash = name.indexOf('/');
  return slash > 0
    && slash === name.lastIndexOf('/')
    && CONTENT_ROOTS.has(name.slice(0, slash))
    && name.length > slash + 1;
}

export interface ExtractedArchiveEntry {
  readonly name: string;
  readonly filePath: string;
  readonly size: number;
}

export class ExtractedSessionArchive {
  constructor(
    readonly stagingDir: string,
    private readonly entries: ReadonlyMap<string, ExtractedArchiveEntry>,
    private readonly limits: Readonly<SessionImportLimits>,
  ) {}

  has(name: string): boolean { return this.entries.has(name); }
  filePath(name: string): string | null { return this.entries.get(name)?.filePath ?? null; }

  readJson<T>(name: string, required = false): T | null {
    const entry = this.entries.get(name);
    if (!entry) {
      if (required) throw new SessionImportError('invalid_format', `备份缺少 ${name}`);
      return null;
    }
    if (entry.size > this.limits.maxJsonBytes) {
      throw new SessionImportError('entry_too_large', `${name} 超过 JSON 大小限制`, 413);
    }
    try {
      return JSON.parse(fs.readFileSync(entry.filePath, 'utf8')) as T;
    } catch {
      throw new SessionImportError('invalid_format', `${name} 不是合法 JSON`);
    }
  }

  dispose(): void { fs.rmSync(this.stagingDir, { recursive: true, force: true }); }
}

/** 压缩输入有硬上限；所有展开内容逐块写临时目录，不同时驻留内存。 */
export function extractSessionArchive(
  archiveBytes: Uint8Array,
  stagingRoot: string,
  limits: Readonly<SessionImportLimits> = SESSION_IMPORT_LIMITS,
): ExtractedSessionArchive {
  if (archiveBytes.byteLength > limits.maxArchiveBytes) {
    throw new SessionImportError('archive_too_large', 'ZIP 文件超过 V1 导入大小限制', 413);
  }

  fs.mkdirSync(stagingRoot, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(stagingRoot, 'session-import-'));
  const entries = new Map<string, ExtractedArchiveEntry>();
  const seenPortableNames = new Set<string>();
  const openFiles = new Set<number>();
  let entryCount = 0;
  let expandedBytes = 0;
  let jsonBytes = 0;

  try {
    const unzip = new Unzip((file) => {
      const name = normalizeArchiveEntryName(file.name);
      const portableName = name.toLocaleLowerCase('en-US');
      if (seenPortableNames.has(portableName)) {
        throw new SessionImportError('invalid_format', `ZIP 存在重复条目: ${name}`);
      }
      seenPortableNames.add(portableName);

      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw new SessionImportError('too_many_entries', 'ZIP 文件数量超过限制', 413);
      }
      if (!isAllowedEntry(name)) {
        throw new SessionImportError('invalid_format', `ZIP 包含未知条目: ${name}`);
      }
      if (file.originalSize !== undefined && file.originalSize > limits.maxEntryBytes) {
        throw new SessionImportError('entry_too_large', `ZIP 条目过大: ${name}`, 413);
      }
      if (
        file.size !== undefined
        && file.originalSize !== undefined
        && file.originalSize > 0
        && file.originalSize / Math.max(file.size, 1) > limits.maxCompressionRatio
      ) {
        throw new SessionImportError('compression_ratio_too_high', `ZIP 条目压缩比异常: ${name}`, 413);
      }

      const isDirectory = name.endsWith('/');
      const destination = resolvePathInside(stagingDir, ...name.split('/').filter(Boolean));
      if (isDirectory) fs.mkdirSync(destination, { recursive: true });
      else fs.mkdirSync(path.dirname(destination), { recursive: true });

      let entryBytes = 0;
      let fd: number | null = isDirectory ? null : fs.openSync(destination, 'wx');
      if (fd !== null) openFiles.add(fd);

      file.ondata = (error, chunk, final) => {
        if (error) throw new SessionImportError('invalid_zip', `ZIP 条目损坏: ${name}`);
        entryBytes += chunk.byteLength;
        expandedBytes += chunk.byteLength;
        if (entryBytes > limits.maxEntryBytes) {
          throw new SessionImportError('entry_too_large', `ZIP 条目过大: ${name}`, 413);
        }
        if (expandedBytes > limits.maxExpandedBytes) {
          throw new SessionImportError('expanded_size_too_large', 'ZIP 展开后总体积超过限制', 413);
        }
        if (fd !== null && chunk.byteLength > 0) fs.writeSync(fd, chunk);

        if (final) {
          if (fd !== null) {
            fs.closeSync(fd);
            openFiles.delete(fd);
            fd = null;
          }
          if (!isDirectory) {
            if (ROOT_JSON_ENTRIES.has(name)) {
              jsonBytes += entryBytes;
              if (entryBytes > limits.maxJsonBytes || jsonBytes > limits.maxJsonTotalBytes) {
                throw new SessionImportError('entry_too_large', 'ZIP 中 JSON 数据超过 V1 导入大小限制', 413);
              }
            }
            entries.set(name, { name, filePath: destination, size: entryBytes });
          }
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);

    const inputChunkBytes = 64 * 1024;
    for (let offset = 0; offset < archiveBytes.byteLength; offset += inputChunkBytes) {
      const end = Math.min(offset + inputChunkBytes, archiveBytes.byteLength);
      unzip.push(archiveBytes.subarray(offset, end), end === archiveBytes.byteLength);
    }

    if (openFiles.size > 0) {
      throw new SessionImportError('invalid_zip', 'ZIP 提前结束，存在未完成条目');
    }
    if (
      expandedBytes > 0
      && expandedBytes / Math.max(archiveBytes.byteLength, 1) > limits.maxCompressionRatio
    ) {
      throw new SessionImportError('compression_ratio_too_high', 'ZIP 总压缩比异常', 413);
    }
    return new ExtractedSessionArchive(stagingDir, entries, limits);
  } catch (error) {
    for (const fd of openFiles) {
      try { fs.closeSync(fd); } catch { /* 清理阶段忽略重复关闭。 */ }
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (error instanceof SessionImportError) throw error;
    throw new SessionImportError('invalid_zip', '无法解压 ZIP 文件');
  }
}
