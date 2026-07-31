// 从已校验完整性的暂存文件增量读取 JSON/JSONL，不把百万行记录聚合进内存。
import fs from 'node:fs';
import { BACKUP_LIMITS, type BackupLimits } from '../limits.js';
import {
  BACKUP_RECORD_REGISTRY,
  recordDefinition,
  type BackupRecordName,
} from '../records/recordRegistry.js';
import { JsonlDecoder, JsonlParseError } from '../records/jsonl.js';
import { SessionImportError } from './errors.js';
import type { ExtractedSessionArchive } from './archive.js';

export function readRecordJson<T>(
  archive: ExtractedSessionArchive,
  name: BackupRecordName,
): T | null {
  const definition = recordDefinition(name);
  if (definition.encoding !== 'json') throw new Error(`${name} 不是 JSON 记录`);
  const entry = archive.get(definition.archivePath);
  if (!entry) {
    if (definition.required) {
      throw new SessionImportError('invalid_format', `备份缺少 ${definition.archivePath}`);
    }
    return null;
  }
  if (entry.size > BACKUP_LIMITS.jsonlMaxLineBytes) {
    throw new SessionImportError('entry_too_large', `${definition.archivePath} 超过 JSON 大小限制`, 413);
  }
  try {
    return JSON.parse(fs.readFileSync(entry.filePath, 'utf8')) as T;
  } catch {
    throw new SessionImportError('invalid_format', `${definition.archivePath} 不是合法 JSON`);
  }
}

export function readRecordJsonl(
  archive: ExtractedSessionArchive,
  name: BackupRecordName,
  limits: BackupLimits = BACKUP_LIMITS,
): Iterable<unknown> {
  const definition = recordDefinition(name);
  if (definition.encoding !== 'jsonl') throw new Error(`${name} 不是 JSONL 记录`);
  const entry = archive.require(definition.archivePath);
  return {
    *[Symbol.iterator](): Iterator<unknown> {
      const descriptor = fs.openSync(entry.filePath, 'r');
      const decoder = new JsonlDecoder({
        entryName: definition.archivePath,
        maxLineBytes: limits.jsonlMaxLineBytes,
        maxRecords: definition.maxRecords,
      });
      const buffer = Buffer.allocUnsafe(64 * 1024);
      try {
        let bytesRead: number;
        while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.byteLength, null)) > 0) {
          yield* decoder.push(buffer.subarray(0, bytesRead));
        }
        yield* decoder.finalize();
      } catch (error) {
        if (error instanceof JsonlParseError) {
          throw new SessionImportError('invalid_format', error.message);
        }
        throw error;
      } finally {
        fs.closeSync(descriptor);
      }
    },
  };
}

export function assertRequiredRecordFiles(archive: ExtractedSessionArchive): void {
  for (const definition of BACKUP_RECORD_REGISTRY) {
    if (definition.required && !archive.get(definition.archivePath)) {
      throw new SessionImportError('invalid_format', `备份缺少 ${definition.archivePath}`);
    }
  }
}
