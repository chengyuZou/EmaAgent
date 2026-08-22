// 在一个 SQLite 读取事务中写出记录，再把 Session 文件复制进本次导出临时目录。
import fs from 'node:fs';
import path from 'node:path';
import type { SessionBackupReader, SessionBackupRows } from '@ema-agent/storage';
import { SESSION_MANIFEST_PATH, sessionRecordFile } from '../records/sessionFormat.js';
import type { OmittedSessionFile, SessionBackupManifest } from '../records/sessionRecords.js';
import {
  toAgentRunMessageRecord,
  toAgentRunRecord,
  toAttachmentRecord,
  toBackgroundProcessRecord,
  toMessageRecord,
  toSessionRecord,
  toSpeechOutputRecord,
  toSpeechSegmentRecord,
  toTaskDependencyRecord,
  toTaskRecord,
  toToolExecutionRecord,
  toTurnRecord,
  toUsageRecord,
} from '../records/exportMappings.js';
import { encodeJsonlRecord } from '../records/jsonl.js';
import type { ZipEntry } from './streamingZip.js';

interface PendingFile {
  readonly kind: OmittedSessionFile['kind'];
  readonly id: string;
  readonly sourcePath: string;
  readonly archivePath: string;
}

export interface StagedSessionExport {
  readonly title: string;
  entries(): AsyncIterable<ZipEntry>;
  dispose(): void;
}

export function stageSessionExport(
  sessionId: string,
  activeDataDir: string,
  temporaryRoot: string,
  reader: SessionBackupReader,
  signal?: AbortSignal,
): StagedSessionExport | null {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'session-'));
  const pending: PendingFile[] = [];
  let title = sessionId;

  try {
    const found = reader.readSession(sessionId, rows => {
      title = rows.session.title;
      writeRecords(directory, activeDataDir, rows, pending, signal);
      return true;
    });
    if (!found) {
      fs.rmSync(directory, { recursive: true, force: true });
      return null;
    }

    const omittedFiles: OmittedSessionFile[] = [];
    for (const file of pending) {
      throwIfCancelled(signal);
      try {
        const stat = fs.statSync(file.sourcePath);
        if (!stat.isFile()) throw new Error('不是普通文件');
        const destination = path.join(directory, ...file.archivePath.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(file.sourcePath, destination, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        omittedFiles.push({
          kind: file.kind,
          id: file.id,
          reason: fs.existsSync(file.sourcePath) ? 'unreadable' : 'missing',
        });
      }
    }

    const manifest: SessionBackupManifest = {
      format: 'ema-session',
      version: 1,
      sessionId,
      omittedFiles,
    };
    fs.writeFileSync(
      path.join(directory, SESSION_MANIFEST_PATH),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    return {
      title,
      entries: () => directoryEntries(directory),
      dispose: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function writeRecords(
  directory: string,
  activeDataDir: string,
  rows: SessionBackupRows,
  pending: PendingFile[],
  signal?: AbortSignal,
): void {
  writeJson(directory, 'session', toSessionRecord(rows.session));
  writeJsonl(directory, 'turns', rows.turns, toTurnRecord, signal);
  writeJsonl(directory, 'messages', rows.messages, toMessageRecord, signal);
  writeJsonl(directory, 'tasks', rows.tasks, toTaskRecord, signal);
  writeJsonl(directory, 'taskDependencies', rows.taskDependencies, toTaskDependencyRecord, signal);
  writeJsonl(directory, 'agentRuns', rows.agentRuns, toAgentRunRecord, signal);
  writeJsonl(directory, 'agentRunMessages', rows.agentRunMessages, toAgentRunMessageRecord, signal);
  writeJsonl(directory, 'toolExecutions', rows.toolExecutions, toToolExecutionRecord, signal);

  const background = [...rows.backgroundProcesses];
  writeJsonl(directory, 'backgroundProcesses', background, row => {
    const archiveRoot = `files/backgroundProcesses/${safeName(row.id)}`;
    const sourceDirectory = path.resolve(activeDataDir, row.output_relative_path);
    for (const file of listFiles(sourceDirectory)) {
      pending.push({
        kind: 'backgroundProcessOutput',
        id: row.id,
        sourcePath: file,
        archivePath: `${archiveRoot}/${relativeArchivePath(sourceDirectory, file)}`,
      });
    }
    return toBackgroundProcessRecord(row, archiveRoot);
  }, signal);

  writeJsonl(directory, 'attachments', rows.attachments, row => {
    const extension = path.extname(row.kind === 'image' ? row.image_path ?? row.source_path : row.source_path);
    const archivePath = `files/attachments/${safeName(row.id)}${safeExtension(extension)}`;
    pending.push({
      kind: 'attachment',
      id: row.id,
      sourcePath: row.kind === 'image' ? row.image_path ?? row.source_path : row.source_path,
      archivePath,
    });
    return toAttachmentRecord(row, archivePath);
  }, signal);

  writeJsonl(directory, 'speechOutputs', rows.speechOutputs, row => {
    const archivePath = `files/speechOutputs/${safeName(row.turn_id)}${safeExtension(path.extname(row.storage_path))}`;
    pending.push({ kind: 'speechOutput', id: row.turn_id, sourcePath: row.storage_path, archivePath });
    return toSpeechOutputRecord(row, archivePath);
  }, signal);

  writeJsonl(directory, 'speechSegments', rows.speechSegments, row => {
    const archivePath = `files/speechSegments/${safeName(row.id)}${safeExtension(path.extname(row.storage_path))}`;
    pending.push({ kind: 'speechSegment', id: row.id, sourcePath: row.storage_path, archivePath });
    return toSpeechSegmentRecord(row, archivePath);
  }, signal);
  writeJsonl(directory, 'usageRecords', rows.usageRecords, toUsageRecord, signal);
}

function writeJson(directory: string, name: 'session', value: unknown): void {
  const target = path.join(directory, ...sessionRecordFile(name).path.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`, 'utf8');
}

function writeJsonl<T>(
  directory: string,
  name: Exclude<Parameters<typeof sessionRecordFile>[0], 'session'>,
  rows: Iterable<T>,
  map: (row: T) => unknown,
  signal?: AbortSignal,
): void {
  const target = path.join(directory, ...sessionRecordFile(name).path.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const descriptor = fs.openSync(target, 'wx');
  try {
    for (const row of rows) {
      throwIfCancelled(signal);
      fs.writeSync(descriptor, encodeJsonlRecord(map(row)));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

async function* directoryEntries(root: string): AsyncGenerator<ZipEntry> {
  for (const filePath of listFiles(root)) {
    const archivePath = relativeArchivePath(root, filePath);
    yield {
      path: archivePath,
      async *chunks(): AsyncGenerator<Uint8Array> {
        for await (const chunk of fs.createReadStream(filePath)) yield chunk as Buffer;
      },
    };
  }
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) result.push(fullPath);
    }
  };
  visit(root);
  return result.sort();
}

function relativeArchivePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function safeExtension(value: string): string {
  return /^\.[A-Za-z0-9]{1,12}$/.test(value) ? value.toLowerCase() : '';
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Session 导出已取消');
}
