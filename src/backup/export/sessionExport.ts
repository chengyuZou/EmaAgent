// 把已经冻结的 Session V2 条目写成带完整性清单的流式 ZIP，不读取数据库或猜测文件路径。
import { createHash } from 'node:crypto';
import {
  BACKUP_FILE_ROOTS,
  BACKUP_INTEGRITY_PATH,
  BACKUP_MANIFEST_PATH,
  BACKUP_RECORD_PATHS,
} from '../records/recordRegistry.js';
import type { SessionBackupManifest } from '../records/sessionRecords.js';
import type { BackupLimits } from '../limits.js';
import type { BackupOutputSink } from '../types.js';
import {
  StreamingZipWriter,
  type StreamingZipEntry,
} from './streamingZip.js';

const encoder = new TextEncoder();

export interface SessionExportEntry extends StreamingZipEntry {}

export interface PreparedSessionExport {
  readonly manifest: SessionBackupManifest;
  /** manifest.json 与 integrity/sha256.json 由导出器生成，调用方不得重复提供。 */
  entries(): AsyncIterable<SessionExportEntry>;
}

export interface IntegrityEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface BackupIntegrityManifest {
  readonly algorithm: 'sha256';
  readonly entries: readonly IntegrityEntry[];
}

export async function exportPreparedSessionV2(
  prepared: PreparedSessionExport,
  sink: BackupOutputSink,
  limits: BackupLimits,
): Promise<void> {
  const writer = new StreamingZipWriter(sink, limits);
  const integrity: IntegrityEntry[] = [];
  const paths = new Set<string>();

  try {
    for await (const entry of prepared.entries()) {
      assertArchiveEntryPath(entry.path);
      assertUniquePath(paths, entry.path);
      const measured = measureEntry(entry);
      await writer.add(measured.entry);
      integrity.push(measured.result());
    }

    const manifestEntry = bytesEntry(
      BACKUP_MANIFEST_PATH,
      encoder.encode(`${JSON.stringify(prepared.manifest)}\n`),
    );
    assertUniquePath(paths, manifestEntry.path);
    const measuredManifest = measureEntry(manifestEntry);
    await writer.add(measuredManifest.entry);
    integrity.push(measuredManifest.result());

    const integrityBytes = encoder.encode(`${JSON.stringify({
      algorithm: 'sha256',
      entries: integrity,
    } satisfies BackupIntegrityManifest)}\n`);
    assertUniquePath(paths, BACKUP_INTEGRITY_PATH);
    await writer.add(bytesEntry(BACKUP_INTEGRITY_PATH, integrityBytes));
    await writer.commit();
  } catch (error) {
    await writer.abort(error);
    throw error;
  }
}

function measureEntry(entry: SessionExportEntry): {
  entry: SessionExportEntry;
  result: () => IntegrityEntry;
} {
  const hash = createHash('sha256');
  let size = 0;
  let digest: string | undefined;

  return {
    entry: {
      path: entry.path,
      declaredSize: entry.declaredSize,
      async *chunks() {
        try {
          for await (const chunk of entry.chunks()) {
            hash.update(chunk);
            size += chunk.byteLength;
            yield chunk;
          }
          digest = hash.digest('hex');
        } catch (error) {
          throw error;
        }
      },
    },
    result: () => {
      if (digest === undefined) throw new Error(`${entry.path} 尚未完成写入`);
      return { path: entry.path, sha256: digest, size };
    },
  };
}

function bytesEntry(path: string, bytes: Uint8Array): SessionExportEntry {
  return {
    path,
    declaredSize: bytes.byteLength,
    async *chunks() {
      yield bytes;
    },
  };
}

function assertUniquePath(paths: Set<string>, path: string): void {
  if (paths.has(path)) throw new Error(`备份条目路径重复: ${path}`);
  paths.add(path);
}

function assertArchiveEntryPath(path: string): void {
  if (path.includes('\\') || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`备份条目路径非法: ${path}`);
  }
  if (BACKUP_RECORD_PATHS.has(path)) return;

  const parts = path.split('/');
  if (
    parts.length >= 4
    && parts[0] === 'files'
    && BACKUP_FILE_ROOTS.has(parts[1]!)
    && parts.slice(2).every((part) => part.length > 0 && part !== '.')
  ) {
    return;
  }
  throw new Error(`备份条目不在 V2 白名单: ${path}`);
}
