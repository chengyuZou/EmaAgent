// 把归档资源发布到目标 Session 目录，并在数据库恢复失败时整目录回滚。
import fs from 'node:fs';
import path from 'node:path';
import { SessionImportError } from '../errors.js';
import type {
  AttachmentRecord,
  BackgroundProcessRecord,
  SpeechOutputRecord,
  SpeechSegmentRecord,
} from '../records/sessionRecords.js';
import type { ExtractedSessionArchive } from './archive.js';

export interface RestoredSessionFiles {
  readonly attachments: ReadonlyMap<string, string>;
  readonly speechOutputs: ReadonlyMap<string, string>;
  readonly speechSegments: ReadonlyMap<string, string>;
  readonly backgroundDirectories: ReadonlyMap<string, string>;
  commit(): void;
  rollback(): void;
}

export function publishSessionFiles(
  activeDataDir: string,
  sessionId: string,
  archive: ExtractedSessionArchive,
  attachments: readonly AttachmentRecord[],
  speechOutputs: readonly SpeechOutputRecord[],
  speechSegments: readonly SpeechSegmentRecord[],
  backgroundProcesses: readonly BackgroundProcessRecord[],
  signal?: AbortSignal,
): RestoredSessionFiles {
  const sessionsRoot = path.join(activeDataDir, 'sessions');
  const finalRoot = path.join(sessionsRoot, sessionId);
  if (fs.existsSync(finalRoot)) {
    throw new SessionImportError('destination_conflict', '目标 Session 文件夹已存在', 409);
  }
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(sessionsRoot, '.session-import-'));
  const attachmentPaths = new Map<string, string>();
  const speechOutputPaths = new Map<string, string>();
  const speechSegmentPaths = new Map<string, string>();
  const backgroundDirectories = new Map<string, string>();
  let published = false;

  try {
    for (const record of attachments) {
      throwIfCancelled(signal);
      const source = archive.get(record.filePath);
      if (!source) continue;
      const destination = path.join(temporaryRoot, 'attachments', fileName(record.id, record.filePath));
      copy(source.filePath, destination, record.byteSize);
      attachmentPaths.set(record.id, toFinal(finalRoot, temporaryRoot, destination));
    }
    for (const record of speechOutputs) {
      throwIfCancelled(signal);
      const source = archive.get(record.filePath);
      if (!source) continue;
      const destination = path.join(temporaryRoot, 'audio', 'merged', fileName(record.turnId, record.filePath));
      copy(source.filePath, destination, record.byteSize);
      speechOutputPaths.set(record.turnId, toFinal(finalRoot, temporaryRoot, destination));
    }
    for (const record of speechSegments) {
      throwIfCancelled(signal);
      const source = archive.get(record.filePath);
      if (!source) continue;
      const destination = path.join(
        temporaryRoot,
        'audio',
        'segments',
        record.turnId,
        fileName(String(record.sentenceIndex), record.filePath),
      );
      copy(source.filePath, destination, record.byteSize);
      speechSegmentPaths.set(record.id, toFinal(finalRoot, temporaryRoot, destination));
    }
    for (const record of backgroundProcesses) {
      throwIfCancelled(signal);
      const destinationRoot = path.join(temporaryRoot, 'background-processes', record.id);
      for (const entryPath of archive.paths()) {
        const prefix = `${record.outputDirectoryPath}/`;
        if (!entryPath.startsWith(prefix)) continue;
        const source = archive.require(entryPath);
        copy(source.filePath, path.join(destinationRoot, ...entryPath.slice(prefix.length).split('/')));
      }
      fs.mkdirSync(destinationRoot, { recursive: true });
      backgroundDirectories.set(record.id, path.relative(activeDataDir, toFinal(finalRoot, temporaryRoot, destinationRoot)));
    }
    fs.renameSync(temporaryRoot, finalRoot);
    published = true;
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    if (error instanceof SessionImportError) throw error;
    throw new SessionImportError(
      'restore_failed',
      error instanceof Error ? error.message : 'Session 文件恢复失败',
      500,
    );
  }

  return {
    attachments: attachmentPaths,
    speechOutputs: speechOutputPaths,
    speechSegments: speechSegmentPaths,
    backgroundDirectories,
    commit(): void { published = false; },
    rollback(): void {
      if (published) fs.rmSync(finalRoot, { recursive: true, force: true });
      published = false;
    },
  };
}

function copy(source: string, destination: string, expectedBytes?: number): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  if (expectedBytes !== undefined && fs.statSync(destination).size !== expectedBytes) {
    throw new SessionImportError('invalid_format', `资源字节数与记录不一致: ${path.basename(destination)}`);
  }
}

function fileName(id: string, archivePath: string): string {
  const extension = path.extname(archivePath);
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}${extension}`;
}

function toFinal(finalRoot: string, temporaryRoot: string, temporaryPath: string): string {
  return path.join(finalRoot, path.relative(temporaryRoot, temporaryPath));
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SessionImportError('import_cancelled', 'Session 导入已取消', 499);
}
