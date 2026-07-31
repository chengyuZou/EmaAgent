// 把一致的 Session 数据快照和受控文件冻结到临时目录，再交给流式 ZIP 导出器读取。
import {
  closeSync,
  copyFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type {
  AttachmentRow,
  AudioEntryRow,
  BackgroundProcessRow,
  SessionBackupReader,
  SessionBackupSnapshot,
} from '@ema-agent/storage';
import { BACKUP_LIMITS, type BackupLimits } from '../limits.js';
import { encodeJsonlLine } from '../records/jsonl.js';
import {
  BACKUP_RECORD_REGISTRY,
  recordDefinition,
} from '../records/recordRegistry.js';
import type { OmittedBackupFile, SessionBackupManifest } from '../records/sessionRecords.js';
import {
  toAgentRunMessageRecord,
  toAgentRunRecord,
  toAttachmentRecord,
  toAudioRecord,
  toBackgroundProcessRecord,
  toKbActivationRecord,
  toMemoryStateRecord,
  toMessageRecord,
  toSessionNotesRecord,
  toSessionRecord,
  toTaskDependencyRecord,
  toTaskRecord,
  toToolExecutionRecord,
  toTurnRecord,
  toUsageRecord,
} from '../records/storageRecordMappings.js';
import type { PreparedSessionExport, SessionExportEntry } from './sessionExport.js';

interface PendingFile {
  readonly kind: OmittedBackupFile['kind'];
  readonly id: string;
  readonly sourcePath: string;
  readonly archivePath: string;
  readonly maxBytes: number;
  readonly expectedBytes?: number;
}

export interface PrepareSessionExportOptions {
  readonly sessionId: string;
  readonly activeDataDir: string;
  readonly generator: string;
  readonly exportedAt?: number;
  readonly limits?: BackupLimits;
  readonly stagingRoot?: string;
}

export interface StagedSessionExport extends PreparedSessionExport {
  dispose(): void;
}

export function prepareSessionExport(
  reader: SessionBackupReader,
  options: PrepareSessionExportOptions,
): StagedSessionExport | null {
  const limits = options.limits ?? BACKUP_LIMITS;
  const root = mkdtempSync(join(options.stagingRoot ?? tmpdir(), 'ema-session-export-'));
  const pendingFiles: PendingFile[] = [];
  const warnings: OmittedBackupFile[] = [];

  try {
    const found = reader.withSnapshot(options.sessionId, (snapshot) => {
      writeRecords(root, snapshot, pendingFiles, limits, options.activeDataDir);
      return true;
    });
    if (!found) {
      rmSync(root, { recursive: true, force: true });
      return null;
    }

    for (const pending of pendingFiles) {
      stageFile(root, pending, warnings);
    }

    const manifest: SessionBackupManifest = {
      format: 'ema-session',
      version: 2,
      sessionId: options.sessionId,
      exportedAt: options.exportedAt ?? Date.now(),
      generator: options.generator,
      warnings,
    };
    return {
      manifest,
      entries: () => stagedEntries(root),
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function writeRecords(
  root: string,
  snapshot: SessionBackupSnapshot,
  pendingFiles: PendingFile[],
  limits: BackupLimits,
  activeDataDir: string,
): void {
  for (const definition of BACKUP_RECORD_REGISTRY) {
    mkdirSync(dirname(join(root, definition.archivePath)), { recursive: true });
    if (definition.encoding === 'jsonl') writeFileSync(join(root, definition.archivePath), '');
  }
  writeJson(root, 'session', toSessionRecord(snapshot.session));

  let totalRecords = 1;
  const writeLines = <T>(
    name: Parameters<typeof recordDefinition>[0],
    rows: Iterable<T>,
    map: (row: T) => unknown,
  ): void => {
    const definition = recordDefinition(name);
    let count = 0;
    const descriptor = openSync(join(root, definition.archivePath), 'a');
    try {
      for (const row of rows) {
        count += 1;
        totalRecords += 1;
        if (count > definition.maxRecords || totalRecords > limits.maxTotalRecords) {
          throw new Error(`备份记录数超过限制: ${name}`);
        }
        const line = encodeJsonlLine(map(row));
        if (line.byteLength > limits.jsonlMaxLineBytes) throw new Error(`备份记录单行过大: ${name}`);
        writeSync(descriptor, line);
      }
    } finally {
      closeSync(descriptor);
    }
  };

  writeLines('turns', snapshot.turns, toTurnRecord);
  writeLines('messages', snapshot.messages, toMessageRecord);
  writeLines('tasks', snapshot.tasks, toTaskRecord);
  writeLines('taskDependencies', snapshot.taskDependencies, toTaskDependencyRecord);
  writeLines('agentRuns', snapshot.agentRuns, toAgentRunRecord);
  writeLines('agentRunMessages', snapshot.agentRunMessages, toAgentRunMessageRecord);
  writeLines('toolExecutions', snapshot.toolExecutions, toToolExecutionRecord);
  writeLines('backgroundProcesses', snapshot.backgroundProcesses, (row) => {
    const archiveDirectory = `files/backgroundProcesses/${safeComponent(row.id)}`;
    for (const name of ['stdout.log', 'stderr.log']) {
      pendingFiles.push({
        kind: 'backgroundProcessOutput',
        id: row.id,
        sourcePath: controlledPath(activeDataDir, row.output_relative_path, name),
        archivePath: `${archiveDirectory}/${name}`,
        maxBytes: limits.maxBackgroundOutputBytes,
        expectedBytes: name === 'stdout.log' ? row.stdout_bytes : row.stderr_bytes,
      });
    }
    return toBackgroundProcessRecord(row, `${archiveDirectory}/`);
  });
  writeLines('attachments', snapshot.attachments, (row) => {
    const archivePath = `files/attachments/${safeComponent(row.id)}/${safeFileName(row.name)}`;
    pendingFiles.push({
      kind: 'attachment', id: row.id, sourcePath: row.local_path,
      archivePath, maxBytes: limits.maxAttachmentBytes,
      expectedBytes: row.size,
    });
    return toAttachmentRecord(row, archivePath);
  });
  writeLines('audio', snapshot.audio, (row) => {
    const suffix = extname(row.storage_path) || '.bin';
    const archivePath = `files/audio/${safeComponent(row.turn_id)}/audio${suffix}`;
    pendingFiles.push({
      kind: 'audio', id: row.turn_id, sourcePath: row.storage_path,
      archivePath, maxBytes: limits.maxAudioBytes,
      expectedBytes: row.byte_size,
    });
    return toAudioRecord(row, snapshot.session.id, archivePath);
  });
  writeLines('usageRecords', snapshot.usageRecords, toUsageRecord);
  writeLines('kbActivations', snapshot.kbActivations, toKbActivationRecord);
  if (snapshot.memoryState) writeJson(root, 'memoryState', toMemoryStateRecord(snapshot.memoryState));
  if (snapshot.sessionNotes) writeJson(root, 'sessionNotes', toSessionNotesRecord(snapshot.sessionNotes));
}

function writeJson(root: string, name: Parameters<typeof recordDefinition>[0], value: unknown): void {
  const path = join(root, recordDefinition(name).archivePath);
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function stageFile(root: string, pending: PendingFile, warnings: OmittedBackupFile[]): void {
  try {
    const before = statSync(pending.sourcePath);
    if (
      !before.isFile()
      || before.size > pending.maxBytes
      || (pending.expectedBytes !== undefined && before.size !== pending.expectedBytes)
    ) {
      throw new Error('unreadable');
    }
    const destination = join(root, ...pending.archivePath.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(pending.sourcePath, destination);
    const after = statSync(pending.sourcePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      rmSync(destination, { force: true });
      throw new Error('changed');
    }
  } catch (error) {
    warnings.push({
      kind: pending.kind,
      id: pending.id,
      reason: isMissingError(error) ? 'missing' : 'unreadable',
    });
  }
}

async function* stagedEntries(root: string): AsyncGenerator<SessionExportEntry> {
  for (const archivePath of listFiles(root)) {
    const diskPath = join(root, ...archivePath.split('/'));
    const size = statSync(diskPath).size;
    yield {
      path: archivePath,
      declaredSize: size,
      async *chunks() {
        for await (const chunk of createReadStream(diskPath)) yield new Uint8Array(chunk);
      },
    };
  }
}

function listFiles(root: string, directory = ''): string[] {
  const output: string[] = [];
  const absolute = join(root, directory);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...listFiles(root, child));
    else if (entry.isFile()) output.push(child);
  }
  return output.sort();
}

function safeComponent(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error('备份资源 ID 不能安全映射为路径');
  }
  return value;
}

function safeFileName(value: string): string {
  const cleaned = basename(value).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  return cleaned || 'file.bin';
}

function controlledPath(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error('后台输出路径越界');
  return target;
}

function isMissingError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}
