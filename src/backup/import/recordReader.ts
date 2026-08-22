// 从已解压目录逐个读取并校验 Session 记录文件。
import fs from 'node:fs';
import type { ZodType } from 'zod';
import { SessionImportError } from '../errors.js';
import { sessionRecordFile } from '../records/sessionFormat.js';
import { readJsonl } from '../records/jsonl.js';
import type { ExtractedSessionArchive } from './archive.js';

export function readJsonRecord<T>(
  archive: ExtractedSessionArchive,
  name: 'session',
  schema: ZodType<T>,
): T {
  const entry = archive.require(sessionRecordFile(name).path);
  try {
    return schema.parse(JSON.parse(fs.readFileSync(entry.filePath, 'utf8')));
  } catch (error) {
    throw invalidRecord(name, error);
  }
}

export async function readJsonlRecords<T>(
  archive: ExtractedSessionArchive,
  name: Exclude<Parameters<typeof sessionRecordFile>[0], 'session'>,
  schema: ZodType<T>,
): Promise<T[]> {
  const entry = archive.require(sessionRecordFile(name).path);
  const records: T[] = [];
  try {
    for await (const record of readJsonl(entry.filePath, value => schema.parse(value))) {
      records.push(record);
    }
    return records;
  } catch (error) {
    throw invalidRecord(name, error);
  }
}

function invalidRecord(name: string, error: unknown): SessionImportError {
  const message = error instanceof Error ? error.message : String(error);
  return new SessionImportError('invalid_format', `${name} 记录无效: ${message}`);
}
