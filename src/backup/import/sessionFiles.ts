import fs from 'node:fs';
import path from 'node:path';
import { SessionImportError } from '../errors.js';
import type {
  AttachmentImageRecord,
  AttachmentPastedTextRecord,
  BackgroundProcessRecord,
  SpeechOutputRecord,
} from '../records/sessionRecords.js';
import type { ExtractedSessionArchive } from './archive.js';
import { normalizeArchivePath, resolveInside } from './pathPolicy.js';

export interface PublishedSessionFiles {
  /** 本次新建的正式目录, 数据库写入失败时由调用方删除. */
  readonly directory: string;
  /** 来源附件路径 -> 恢复后的路径, 用于重写消息中的受管附件引用. */
  readonly attachments: ReadonlyMap<string, string>;
  /** 归档文件路径 -> 恢复后的正式路径, 同轮不同角色不能共用 Turn ID 作为键. */
  readonly speechOutputs: ReadonlyMap<string, string>;
  readonly backgroundDirectories: ReadonlyMap<string, string>;
}

export function publishSessionFiles(
  activeDataDir: string,
  sessionId: string,
  archive: ExtractedSessionArchive,
  attachmentImages: readonly AttachmentImageRecord[],
  attachmentPastedTexts: readonly AttachmentPastedTextRecord[],
  speechOutputs: readonly SpeechOutputRecord[],
  backgroundProcesses: readonly BackgroundProcessRecord[],
  signal?: AbortSignal,
): PublishedSessionFiles {
  const sessionsRoot = path.join(activeDataDir, 'sessions');
  const finalRoot = resolveInside(sessionsRoot, normalizeArchivePath(sessionId));
  if (fs.existsSync(finalRoot)) {
    throw new SessionImportError('destination_conflict', '目标 Session 文件夹已存在', 409);
  }
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(sessionsRoot, '.session-import-'));
  const attachmentPaths = new Map<string, string>();
  const publishAttachment = (
    record: AttachmentImageRecord | AttachmentPastedTextRecord,
    subdir: 'images' | 'pasted',
  ): void => {
    const source = archive.get(record.filePath);
    if (!source) {
      return;
    }
    // 来源可能使用另一操作系统的路径分隔符, 只取已有 UUID 文件名.
    const filename = path.posix.basename(record.path.replaceAll('\\', '/'));
    const destination = path.join(temporaryRoot, 'attachments', subdir, filename);
    copy(source.filePath, destination, record.byteSize);
    attachmentPaths.set(record.path, toFinal(finalRoot, temporaryRoot, destination));
  };
  const speechOutputPaths = new Map<string, string>();
  const backgroundDirectories = new Map<string, string>();
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
      if (!source) {
        continue;
      }
      const destination = path.join(temporaryRoot, 'audio', record.turnId, fileName);
      copy(source.filePath, destination, record.byteSize);
      speechOutputPaths.set(record.filePath, toFinal(finalRoot, temporaryRoot, destination));
    }
    for (const record of backgroundProcesses) {
      signal?.throwIfAborted();
      const destinationRoot = resolveInside(
        temporaryRoot,
        normalizeArchivePath(`background-processes/${record.id}`),
      );
      for (const entryPath of archive.paths()) {
        const prefix = `${record.outputDirectoryPath}/`;
        if (!entryPath.startsWith(prefix)) {
          continue;
        }
        const source = archive.require(entryPath);
        copy(source.filePath, path.join(destinationRoot, ...entryPath.slice(prefix.length).split('/')));
      }
      fs.mkdirSync(destinationRoot, { recursive: true });
      backgroundDirectories.set(
        record.id,
        path.relative(activeDataDir, toFinal(finalRoot, temporaryRoot, destinationRoot)),
      );
    }
    // 文件全部复制并检查完后再发布, 避免正式目录留下半份导入内容.
    fs.renameSync(temporaryRoot, finalRoot);
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    if (signal?.aborted) {
      throw new SessionImportError('import_cancelled', 'Session 导入已取消', 499);
    }
    if (error instanceof SessionImportError) {
      throw error;
    }
    throw new SessionImportError(
      'restore_failed',
      error instanceof Error ? error.message : 'Session 文件恢复失败',
      500,
    );
  }

  return {
    directory: finalRoot,
    attachments: attachmentPaths,
    speechOutputs: speechOutputPaths,
    backgroundDirectories,
  };
}

function copy(source: string, destination: string, expectedBytes?: number): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  if (expectedBytes !== undefined && fs.statSync(destination).size !== expectedBytes) {
    throw new SessionImportError('invalid_format', `资源字节数与记录不一致: ${path.basename(destination)}`);
  }
}

function toFinal(finalRoot: string, temporaryRoot: string, temporaryPath: string): string {
  return path.join(finalRoot, path.relative(temporaryRoot, temporaryPath));
}

