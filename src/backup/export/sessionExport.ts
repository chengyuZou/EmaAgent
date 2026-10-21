import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import type { SessionBackupReader, SessionBackupRows } from '@ema-agent/storage';
import { sessionResourceDir } from '@ema-agent/storage/dataPaths';
import type { SessionExportResult } from '../types.js';
import { SessionExportError } from '../errors.js';
import {
  SESSION_MANIFEST_PATH,
  SESSION_RECORD_PATHS,
  type SessionRecordName,
} from '../records/sessionFormat.js';
import type { OmittedSessionFile, SessionBackupManifest, SessionResourceFile } from '../records/sessionRecords.js';
import {
  toSubagentMessageRecord,
  toSubagentRecord,
  toSubagentRunRecord,
  toAttachmentImageRecord,
  toAttachmentPastedTextRecord,
  toBackgroundProcessRecord,
  toMessageRecord,
  toGoalRecord,
  toSessionRecord,
  toSpeechOutputRecord,
  toTaskRecord,
  toToolExecutionRecord,
  toTurnRecord,
  toUsageRecord,
} from '../records/exportMappings.js';
import { encodeJsonlRecord } from '../records/jsonl.js';

interface PendingFile {
  readonly kind: OmittedSessionFile['kind'];
  readonly id: string;
  readonly sourcePath: string;
  readonly archivePath: string;
}

export async function exportSessionArchive(
  sessionId: string,
  // ZIP 文件的完整保存路径.
  destinationPath: string,
  // 收集 Session 资源文件的数据目录.
  sourcePath: string,
  reader: SessionBackupReader,
  signal?: AbortSignal,
): Promise<SessionExportResult> {
  let recordDirectory: string | null = null;
  let outputDirectory: string | null = null;
  try {
    signal?.throwIfAborted();
    const temporaryRoot = path.join(sourcePath, '.backup-temp', 'exports');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'session-'));
    recordDirectory = directory;
    const pending: PendingFile[] = [];

    // 同一次读取事务中的记录先写到目录里, 事务结束后再复制附件和音频.
    const found = reader.readSession(sessionId, rows => {
      writeRecords(directory, sourcePath, rows, pending, signal);
      return true;
    });
    if (!found) {
      throw new SessionExportError('session_not_found', 'Session 不存在', 404);
    }
    const omittedFiles: OmittedSessionFile[] = [];
    const resourceFiles = collectResourceFiles(sourcePath, sessionId, pending, omittedFiles);
    omittedFiles.push(...copySessionFiles(directory, pending, signal));
    const manifest: SessionBackupManifest = { sessionId, omittedFiles, resourceFiles };
    fs.writeFileSync(
      path.join(directory, SESSION_MANIFEST_PATH),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    // 先在目标文件旁写临时 ZIP, 全部写完才替换用户选中的文件.
    // 同目录重命名不需要跨磁盘复制; 写入失败也不会损坏已有备份.
    outputDirectory = fs.mkdtempSync(path.join(path.dirname(destinationPath), '.ema-session-export-'));
    const temporaryPath = path.join(outputDirectory, 'session.zip');
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('warning', error => archive.destroy(error));
    const written = pipeline(archive, fs.createWriteStream(temporaryPath, { flags: 'wx' }), { signal });
    try {
      archive.directory(directory, false);
      // finalize 只表示不再添加条目; pipeline 完成才表示输出文件也写完并关闭.
      await Promise.all([archive.finalize(), written]);
    } finally {
      archive.abort();
      await written.catch(() => {});
    }
    signal?.throwIfAborted();
    fs.renameSync(temporaryPath, destinationPath);
    return {
      filePath: destinationPath,
      warnings: omittedFiles.map(file => `${file.kind}:${file.id} 未包含文件内容`),
    };
  } catch (error) {
    if (signal?.aborted) {
      throw new SessionExportError('export_cancelled', 'Session 导出已取消', 499);
    }
    if (error instanceof SessionExportError) {
      throw error;
    }
    throw new SessionExportError(
      'export_failed',
      error instanceof Error ? error.message : 'Session 导出失败',
    );
  } finally {
    if (recordDirectory) {
      fs.rmSync(recordDirectory, { recursive: true, force: true });
    }
    if (outputDirectory) {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  }
}

function copySessionFiles(
  directory: string,
  pending: readonly PendingFile[],
  signal?: AbortSignal,
): OmittedSessionFile[] {
  const omittedFiles: OmittedSessionFile[] = [];
  for (const file of pending) {
    signal?.throwIfAborted();
    const destination = path.join(directory, ...file.archivePath.split('/'));
    try {
      if (!fs.statSync(file.sourcePath).isFile()) {
        throw new Error('不是普通文件');
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file.sourcePath, destination, fs.constants.COPYFILE_EXCL);
    } catch {
      // 复制失败可能已经产生部分文件, 不能把它与缺失警告一起打进 ZIP.
      if (fs.existsSync(destination)) {
        fs.unlinkSync(destination);
      }
      omittedFiles.push({
        kind: file.kind,
        id: file.id,
        reason: fs.existsSync(file.sourcePath) ? 'unreadable' : 'missing',
      });
    }
  }
  return omittedFiles;
}

function collectResourceFiles(
  dataDir: string,
  sessionId: string,
  pending: PendingFile[],
  omitted: OmittedSessionFile[],
): SessionResourceFile[] {
  const records: SessionResourceFile[] = [];
  for (const kind of ['web-fetch', 'tool-results'] as const) {
    const root = sessionResourceDir(dataDir, kind, sessionId);
    if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      // Interrupted downloads are not usable resources and must not be restored.
      if (!entry.isFile() || entry.name.endsWith('.pending')) continue;
      const sourcePath = path.join(root, entry.name);
      const filePath = `files/${kind}/${entry.name}`;
      try {
        const stat = fs.statSync(sourcePath);
        records.push({ kind, sourcePath, filePath, byteSize: stat.size, modifiedAt: stat.mtimeMs });
        pending.push({ kind, id: sourcePath, sourcePath, archivePath: filePath });
      } catch {
        omitted.push({ kind, id: sourcePath, reason: fs.existsSync(sourcePath) ? 'unreadable' : 'missing' });
      }
    }
  }
  return records;
}

function writeRecords(
  directory: string,
  sourcePath: string,
  rows: SessionBackupRows,
  pending: PendingFile[],
  signal?: AbortSignal,
): void {
  const sessionPath = path.join(directory, SESSION_RECORD_PATHS.session);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify(toSessionRecord(rows.session))}\n`, 'utf8');
  writeJsonl(directory, 'turns', rows.turns, toTurnRecord, signal);
  writeJsonl(directory, 'messages', rows.messages, toMessageRecord, signal);
  writeJsonl(directory, 'tasks', rows.tasks, toTaskRecord, signal);
  writeJsonl(directory, 'goals', rows.goals, toGoalRecord, signal);
  writeJsonl(directory, 'subagents', rows.subagents, toSubagentRecord, signal);
  writeJsonl(directory, 'subagentRuns', rows.subagentRuns, toSubagentRunRecord, signal);
  writeJsonl(directory, 'subagentMessages', rows.subagentMessages, toSubagentMessageRecord, signal);
  writeJsonl(directory, 'toolExecutions', rows.toolExecutions, toToolExecutionRecord, signal);

  writeJsonl(directory, 'backgroundProcesses', rows.backgroundProcesses, row => {
    const archiveRoot = `files/backgroundProcesses/${safeName(row.id)}`;
    const sourceDirectory = path.resolve(sourcePath, row.output_relative_path);
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

  writeJsonl(directory, 'attachmentImages', rows.attachmentImages, row => {
    // 附件使用已有 UUID 文件名, 恢复到另一数据目录时文件名不变.
    const archivePath = `files/attachments/${safeName(path.basename(row.path))}`;
    pending.push({
      kind: 'attachment',
      id: row.path,
      sourcePath: row.path,
      archivePath,
    });
    return toAttachmentImageRecord(row, archivePath);
  }, signal);

  writeJsonl(directory, 'attachmentPastedTexts', rows.attachmentPastedTexts, row => {
    const archivePath = `files/attachments/${safeName(path.basename(row.path))}`;
    pending.push({
      kind: 'attachment',
      id: row.path,
      sourcePath: row.path,
      archivePath,
    });
    return toAttachmentPastedTextRecord(row, archivePath);
  }, signal);

  writeJsonl(directory, 'speechOutputs', rows.speechOutputs, row => {
    const archivePath = `files/speechOutputs/${safeName(row.turn_id)}/${path.basename(row.storage_path)}`;
    pending.push({
      kind: 'speechOutput',
      id: row.turn_id,
      sourcePath: row.storage_path,
      archivePath,
    });
    return toSpeechOutputRecord(row, archivePath);
  }, signal);

  writeJsonl(directory, 'usageRecords', rows.usageRecords, toUsageRecord, signal);
}

function writeJsonl<T>(
  directory: string,
  name: Exclude<SessionRecordName, 'session'>,
  rows: Iterable<T>,
  map: (row: T) => unknown,
  signal?: AbortSignal,
): void {
  const target = path.join(directory, SESSION_RECORD_PATHS[name]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const descriptor = fs.openSync(target, 'wx');
  try {
    for (const row of rows) {
      signal?.throwIfAborted();
      fs.writeSync(descriptor, encodeJsonlRecord(map(row)));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        result.push(fullPath);
      }
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
