import fs from 'node:fs';
import path from 'node:path';
import { SESSION_RESOURCE_KINDS, dataResourceDir, sessionResourceDir, type SessionResourceKind } from '@ema-agent/storage/dataPaths';
import { SessionImportError } from '../errors.js';
import type {
  AttachmentImageRecord,
  AttachmentPastedTextRecord,
  BackgroundProcessRecord,
  SessionResourceFile,
  SpeechOutputRecord,
} from '../records/sessionRecords.js';
import type { ExtractedSessionArchive } from './archive.js';
import { normalizeArchivePath, resolveInside } from './pathPolicy.js';

export interface PublishedSessionFiles {
  /** Only directories created by this import. SQL failure must not remove any existing files. */
  readonly directories: readonly string[];
  readonly attachments: ReadonlyMap<string, string>;
  readonly speechOutputs: ReadonlyMap<string, string>;
  readonly backgroundDirectories: ReadonlyMap<string, string>;
  readonly resources: ReadonlyMap<string, string>;
}

export function publishSessionFiles(
  activeDataDir: string,
  sessionId: string,
  archive: ExtractedSessionArchive,
  attachmentImages: readonly AttachmentImageRecord[],
  attachmentPastedTexts: readonly AttachmentPastedTextRecord[],
  speechOutputs: readonly SpeechOutputRecord[],
  backgroundProcesses: readonly BackgroundProcessRecord[],
  resourceFiles: readonly SessionResourceFile[],
  signal?: AbortSignal,
): PublishedSessionFiles {
  const normalizedId = normalizeArchivePath(sessionId);
  if (normalizedId.includes('/')) {
    throw new SessionImportError('unsafe_archive_path', 'Session id must be a single path component');
  }
  for (const kind of SESSION_RESOURCE_KINDS) {
    const root = dataResourceDir(activeDataDir, kind);
    const finalRoot = sessionResourceDir(activeDataDir, kind, normalizedId);
    if ((fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) || fs.existsSync(finalRoot)) {
      throw new SessionImportError('destination_conflict', '目标 Session 资源目录已存在或资源根目录是符号链接', 409);
    }
  }
  // Staging stays under .backup-temp. Startup can remove it even before files are published.
  const temporaryRoot = fs.mkdtempSync(path.join(archive.directory, '.publish-'));
  const directories: string[] = [];
  const attachmentPaths = new Map<string, string>();
  const speechOutputPaths = new Map<string, string>();
  const backgroundDirectories = new Map<string, string>();
  const resources = new Map<string, string>();
  const kinds = new Set<SessionResourceKind>();
  const stagePath = (kind: SessionResourceKind, relativePath: string): string => {
    kinds.add(kind);
    return resolveInside(path.join(temporaryRoot, kind), normalizeArchivePath(relativePath));
  };
  const finalPath = (kind: SessionResourceKind, relativePath: string): string =>
    resolveInside(sessionResourceDir(activeDataDir, kind, normalizedId), normalizeArchivePath(relativePath));
  const publishAttachment = (
    record: AttachmentImageRecord | AttachmentPastedTextRecord,
    subdir: 'images' | 'pasted',
  ): void => {
    const source = archive.get(record.filePath);
    if (!source) return;
    const filename = path.posix.basename(record.path.replaceAll('\\', '/'));
    const relativePath = `${subdir}/${filename}`;
    copy(source.filePath, stagePath('attachments', relativePath), record.byteSize);
    attachmentPaths.set(record.path, finalPath('attachments', relativePath));
  };

  try {
    for (const record of attachmentImages) {
      signal?.throwIfAborted();
      publishAttachment(record, 'images');
    }
    for (const record of attachmentPastedTexts) {
      signal?.throwIfAborted();
      publishAttachment(record, 'pasted');
    }
    for (const record of speechOutputs) {
      signal?.throwIfAborted();
      const parts = record.filePath.split('/');
      const fileName = parts[3];
      const prefix = `${record.turnId}-`;
      if (parts.length !== 4 || parts[0] !== 'files' || parts[1] !== 'speechOutputs'
        || parts[2] !== record.turnId || !fileName?.startsWith(prefix)
        || !fileName.endsWith('.wav') || fileName.length <= prefix.length + '.wav'.length) {
        throw new SessionImportError('invalid_format', `语音文件名与 Turn 不一致: ${record.filePath}`);
      }
      const source = archive.get(record.filePath);
      if (!source) continue;
      const relativePath = `${record.turnId}/${fileName}`;
      copy(source.filePath, stagePath('audio', relativePath), record.byteSize);
      speechOutputPaths.set(record.filePath, finalPath('audio', relativePath));
    }
    for (const record of backgroundProcesses) {
      signal?.throwIfAborted();
      const destinationRoot = stagePath('background-processes', record.id);
      fs.mkdirSync(destinationRoot, { recursive: true });
      for (const entryPath of archive.paths()) {
        const prefix = `${record.outputDirectoryPath}/`;
        if (!entryPath.startsWith(prefix)) continue;
        const source = archive.require(entryPath);
        copy(source.filePath, resolveInside(destinationRoot, normalizeArchivePath(entryPath.slice(prefix.length))));
      }
      backgroundDirectories.set(
        record.id,
        path.relative(activeDataDir, finalPath('background-processes', record.id)),
      );
    }
    for (const record of resourceFiles) {
      signal?.throwIfAborted();
      const parts = normalizeArchivePath(record.filePath).split('/');
      const filename = parts[2];
      if (parts.length !== 3 || parts[0] !== 'files' || parts[1] !== record.kind
        || !filename || filename.endsWith('.pending') || resources.has(record.sourcePath)) {
        throw new SessionImportError('invalid_format', `资源路径无效或重复: ${record.filePath}`);
      }
      const source = archive.get(record.filePath);
      if (!source) continue;
      const destination = stagePath(record.kind, filename);
      copy(source.filePath, destination, record.byteSize);
      const modifiedAt = new Date(record.modifiedAt);
      fs.utimesSync(destination, modifiedAt, modifiedAt);
      resources.set(record.sourcePath, finalPath(record.kind, filename));
    }
    // All files are prepared first. Each successful publish is tracked for partial rollback.
    for (const kind of kinds) {
      signal?.throwIfAborted();
      const root = dataResourceDir(activeDataDir, kind);
      const finalRoot = sessionResourceDir(activeDataDir, kind, normalizedId);
      fs.mkdirSync(root, { recursive: true });
      if (fs.existsSync(finalRoot)) {
        throw new SessionImportError('destination_conflict', '目标 Session 资源目录已存在', 409);
      }
      fs.renameSync(path.join(temporaryRoot, kind), finalRoot);
      directories.push(finalRoot);
    }
    signal?.throwIfAborted();
  } catch (error) {
    removePublishedSessionFiles(directories);
    if (signal?.aborted) {
      throw new SessionImportError('import_cancelled', 'Session 导入已取消', 499);
    }
    if (error instanceof SessionImportError) throw error;
    throw new SessionImportError(
      'restore_failed',
      error instanceof Error ? error.message : 'Session 文件恢复失败',
      500,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  return {
    directories,
    attachments: attachmentPaths,
    speechOutputs: speechOutputPaths,
    backgroundDirectories,
    resources,
  };
}

export function removePublishedSessionFiles(directories: readonly string[]): void {
  for (const directory of [...directories].reverse()) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function copy(source: string, destination: string, expectedBytes?: number): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  if (expectedBytes !== undefined && fs.statSync(destination).size !== expectedBytes) {
    throw new SessionImportError('invalid_format', `资源字节数与记录不一致: ${path.basename(destination)}`);
  }
}

